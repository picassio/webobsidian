import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BlobStore } from './blob-store.js';
import { MergeBaseStore } from './base-store.js';
import { JournalStore } from './journal.js';
import { RevisionStore } from './revision-store.js';
import { ensureSyncStorage } from './storage.js';

export class CursorExpiredError extends Error {
  readonly code = 'cursor_expired';
  constructor(public readonly cursor: number, public readonly earliestAvailable: number) {
    super(`cursor ${cursor} predates retained history beginning at ${earliestAvailable}`);
    this.name = 'CursorExpiredError';
  }
}

export interface RetentionOptions {
  now?: Date;
  retentionMs: number;
  minimumAcknowledgedSequence: number | null;
  maxBasesPerEntry: number;
  protectedBlobHashes?: ReadonlySet<string>;
}

export interface CompactionResult {
  throughSequence: number;
  removedSegments: number[];
  removedTombstones: number;
  removedBases: number;
  removedBlobs: number;
  backupDirectory: string | null;
}

export class SyncRetentionManager {
  private readonly journal: JournalStore;
  private readonly revisions: RevisionStore;
  private readonly bases: MergeBaseStore;
  private readonly blobs: BlobStore;

  constructor(private readonly dataDir: string) {
    this.journal = new JournalStore(dataDir);
    this.revisions = new RevisionStore(dataDir);
    this.blobs = new BlobStore(dataDir);
    this.bases = new MergeBaseStore(dataDir, this.blobs);
  }

  async assertCursorAvailable(after: number): Promise<void> {
    const earliest = await this.journal.earliestSequence();
    if (earliest !== null && after < earliest - 1) throw new CursorExpiredError(after, earliest);
  }

  async compact(options: RetentionOptions): Promise<CompactionResult> {
    if (options.retentionMs < 0 || !Number.isFinite(options.retentionMs)) throw new Error('invalid retention age');
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - options.retentionMs);
    // Projection is rebuildable from the authoritative journal, but a periodic
    // checkpoint bounds restart replay even when compaction is acknowledgement-blocked.
    await this.revisions.flushProjection();
    const acknowledged = options.minimumAcknowledgedSequence;
    if (acknowledged === null) return emptyResult();

    const events = await this.journal.replay();
    let throughSequence = 0;
    for (const event of events) {
      if (event.sequence <= acknowledged && Date.parse(event.occurredAt) < cutoff.getTime()) throughSequence = event.sequence;
      else break;
    }
    if (throughSequence === 0) return emptyResult();

    // Journal deletion is safe only after the checkpoint above reached the boundary.
    const backupDirectory = await this.backupMetadata(now);
    const removedSegments = await this.journal.compactThrough(throughSequence, path.join(backupDirectory, 'journal'));
    const removedTombstones = await this.revisions.pruneTombstones(throughSequence, cutoff);
    const baseResult = await this.bases.prune({
      now,
      maxAgeMs: options.retentionMs,
      maxPerEntry: options.maxBasesPerEntry,
      protectedHashes: options.protectedBlobHashes,
    });

    const snapshot = await this.revisions.load();
    const references = new Set<string>([
      ...baseResult.referencedHashes,
      ...(options.protectedBlobHashes ?? []),
    ]);
    for (const entry of snapshot?.entries ?? []) if (entry.hash) references.add(entry.hash);
    for (const event of await this.journal.replay()) {
      if (event.hash) references.add(event.hash);
      if (event.previousHash) references.add(event.previousHash);
    }
    const removedBlobs = await this.blobs.removeUnreferenced(references, cutoff);
    return {
      throughSequence,
      removedSegments,
      removedTombstones: removedTombstones.length,
      removedBases: baseResult.removed.length,
      removedBlobs: removedBlobs.length,
      backupDirectory,
    };
  }

  private async backupMetadata(now: Date): Promise<string> {
    const paths = await ensureSyncStorage(this.dataDir);
    const backup = path.join(
      paths.root,
      'backups',
      `compact-${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`,
    );
    await fs.mkdir(backup, { recursive: true, mode: 0o700 });
    for (const name of ['vault.json', 'revisions.json', 'idempotency.json', 'devices.json', 'conflicts.json']) {
      try { await fs.copyFile(path.join(paths.root, name), path.join(backup, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const handle = await fs.open(backup, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    return backup;
  }
}

function emptyResult(): CompactionResult {
  return { throughSequence: 0, removedSegments: [], removedTombstones: 0, removedBases: 0, removedBlobs: 0, backupDirectory: null };
}

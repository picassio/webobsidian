import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  SyncEntrySchema,
  SyncEventSchema,
  assertNoCaseFoldCollision,
  evaluatePathPolicy,
  sha256Chunks,
  type SyncEntry,
  type SyncEvent,
} from '@picassio/sync-core';
import { AtomicJsonStore, ensureSyncStorage } from './storage.js';
import { JournalStore } from './journal.js';

const REVISION_SCHEMA_VERSION = 1;
const RevisionSnapshotSchema = z.object({
  schemaVersion: z.literal(REVISION_SCHEMA_VERSION),
  currentSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  entries: z.array(SyncEntrySchema),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
type RevisionSnapshot = z.infer<typeof RevisionSnapshotSchema>;
const BootstrapCheckpointSchema = z.object({
  schemaVersion: z.literal(1), vaultRoot: z.string(), entries: z.array(SyncEntrySchema),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export class RevisionStore {
  private snapshot: RevisionSnapshot | null = null;
  private store: AtomicJsonStore<RevisionSnapshot> | null = null;
  private persistedSequence = 0;
  private unflushedEvents = 0;
  private entriesById = new Map<string, SyncEntry>();
  private livePaths = new Map<string, string>();
  private entriesDirty = false;

  constructor(private readonly dataDir: string) {}

  async load(): Promise<RevisionSnapshot | null> {
    await this.ensureLoaded();
    this.materializeEntries();
    return this.snapshot;
  }

  private async ensureLoaded(): Promise<RevisionSnapshot | null> {
    await this.ensureStore();
    if (!this.snapshot) {
      this.snapshot = await this.store!.read();
      if (this.snapshot) {
        this.persistedSequence = this.snapshot.currentSequence;
        this.initializeMaps(this.snapshot.entries);
        const journal = new JournalStore(this.dataDir);
        const latest = await journal.latestSequence();
        if (this.snapshot.currentSequence > latest) throw new Error('revision snapshot is ahead of committed journal');
        for (const event of await journal.replay(this.snapshot.currentSequence)) this.projectEvent(event);
      }
    }
    return this.snapshot;
  }

  async initializeFromVault(vaultRoot: string): Promise<RevisionSnapshot> {
    const existing = await this.load();
    const paths = await ensureSyncStorage(this.dataDir);
    const checkpointFile = path.join(paths.root, 'bootstrap.json');
    if (existing) {
      await fs.rm(checkpointFile, { force: true });
      await fs.rm(`${checkpointFile}.bak`, { force: true });
      return existing;
    }
    const checkpointStore = new AtomicJsonStore(checkpointFile, BootstrapCheckpointSchema);
    const realRoot = await fs.realpath(vaultRoot);
    const prior = await checkpointStore.read();
    const resumedEntries = prior?.vaultRoot === realRoot ? prior.entries : [];
    const entries = await scanVaultSnapshot(realRoot, resumedEntries, async (partial) => {
      await checkpointStore.write({ schemaVersion: 1, vaultRoot: realRoot, entries: partial, updatedAt: new Date().toISOString() });
    });
    const snapshot: RevisionSnapshot = {
      schemaVersion: REVISION_SCHEMA_VERSION,
      currentSequence: 0,
      entries,
      updatedAt: new Date().toISOString(),
    };
    await this.store!.write(snapshot);
    this.persistedSequence = snapshot.currentSequence;
    this.unflushedEvents = 0;
    await fs.rm(checkpointFile, { force: true });
    await fs.rm(`${checkpointFile}.bak`, { force: true });
    this.snapshot = snapshot;
    this.initializeMaps(snapshot.entries);
    return snapshot;
  }

  async getById(entryId: string): Promise<SyncEntry | null> {
    await this.ensureLoaded();
    return this.entriesById.get(entryId) ?? null;
  }

  async getByPath(pathValue: string): Promise<SyncEntry | null> {
    await this.ensureLoaded();
    const entryId = this.livePaths.get(foldPath(pathValue));
    return entryId ? this.entriesById.get(entryId) ?? null : null;
  }

  async currentSequence(): Promise<number> {
    return (await this.ensureLoaded())?.currentSequence ?? 0;
  }

  async applyCommittedEvent(eventInput: SyncEvent): Promise<RevisionSnapshot> {
    const event = SyncEventSchema.parse(eventInput);
    const current = await this.ensureLoaded();
    if (!current) throw new Error('revision store must be initialized before replay');
    if (event.sequence <= current.currentSequence) return current;
    this.projectEvent(event);
    this.unflushedEvents += 1;
    // The journal is the durable commit point. Projection checkpoints are
    // flushed by maintenance/shutdown, never on the latency-sensitive write path.
    return this.snapshot!;
  }

  async flushProjection(): Promise<RevisionSnapshot> {
    const current = await this.ensureLoaded();
    if (!current) throw new Error('revision store must be initialized before flush');
    this.materializeEntries();
    if (this.persistedSequence < current.currentSequence) {
      await this.store!.write(current);
      this.persistedSequence = current.currentSequence;
      this.unflushedEvents = 0;
    }
    return current;
  }

  private projectEvent(event: SyncEvent): void {
    if (!this.snapshot) throw new Error('revision store must be initialized before projection');
    const expected = this.snapshot.currentSequence + 1;
    if (event.sequence !== expected) throw new Error(`event sequence gap: expected ${expected}, got ${event.sequence}`);
    const previous = this.entriesById.get(event.entryId);
    const creating = event.operation === 'create' || event.operation === 'mkdir';
    if (creating && previous && !previous.deleted) throw new Error(`entry ${event.entryId} already exists`);
    if (!creating && !previous) throw new Error(`event references unknown entry ${event.entryId}`);
    if (previous && !creating && event.revision <= previous.revision) throw new Error(`revision must increase for ${event.entryId}`);
    if (previous && !previous.deleted) this.livePaths.delete(foldPath(previous.path));
    const collision = this.livePaths.get(foldPath(event.path));
    if (collision && collision !== event.entryId) throw new Error(`live path collision: ${event.path}`);
    const deleted = event.operation === 'delete' || event.operation === 'rmdir';
    const updated: SyncEntry = creating ? {
      entryId: event.entryId, path: event.path, kind: event.operation === 'mkdir' ? 'directory' : 'file',
      revision: event.revision, hash: event.hash, size: event.size, modifiedAt: event.occurredAt,
      deleted: false, sequence: event.sequence,
    } : {
      ...previous!, path: event.path, revision: event.revision, hash: deleted ? null : event.hash,
      size: deleted ? 0 : event.size, modifiedAt: event.occurredAt, deleted, sequence: event.sequence,
    };
    this.entriesById.set(event.entryId, updated);
    if (!deleted) this.livePaths.set(foldPath(updated.path), updated.entryId);
    if (event.operation === 'rename' && previous?.kind === 'directory') {
      const oldPrefix = `${event.oldPath}/`; const newPrefix = `${event.path}/`;
      for (const [entryId, child] of this.entriesById) {
        if (entryId === event.entryId || child.deleted || !child.path.startsWith(oldPrefix)) continue;
        this.livePaths.delete(foldPath(child.path));
        const moved = { ...child, path: newPrefix + child.path.slice(oldPrefix.length) };
        const childCollision = this.livePaths.get(foldPath(moved.path));
        if (childCollision && childCollision !== entryId) throw new Error(`live path collision: ${moved.path}`);
        this.entriesById.set(entryId, moved); this.livePaths.set(foldPath(moved.path), entryId);
      }
    }
    this.snapshot.currentSequence = event.sequence;
    this.snapshot.updatedAt = new Date().toISOString();
    this.entriesDirty = true;
  }

  private initializeMaps(entries: readonly SyncEntry[]): void {
    this.entriesById = new Map(entries.map((entry) => [entry.entryId, entry]));
    this.livePaths = new Map(entries.filter((entry) => !entry.deleted).map((entry) => [foldPath(entry.path), entry.entryId]));
    this.entriesDirty = false;
  }

  private materializeEntries(): void {
    if (!this.snapshot || !this.entriesDirty) return;
    this.snapshot.entries = [...this.entriesById.values()].sort((a, b) => a.path.localeCompare(b.path));
    this.entriesDirty = false;
  }

  async pruneTombstones(throughSequence: number, olderThan: Date): Promise<SyncEntry[]> {
    const current = await this.load();
    if (!current) throw new Error('revision store must be initialized before pruning');
    const removed = current.entries.filter(
      (entry) => entry.deleted && entry.sequence <= throughSequence && Date.parse(entry.modifiedAt) < olderThan.getTime(),
    );
    if (!removed.length) return [];
    await this.replaceFromReplay(
      current.entries.filter((entry) => !removed.includes(entry)),
      current.currentSequence,
    );
    return removed;
  }

  async replaceFromReplay(entries: Iterable<SyncEntry>, sequence: number): Promise<RevisionSnapshot> {
    const list = [...entries].map((entry) => SyncEntrySchema.parse(entry));
    assertNoCaseFoldCollision(list.filter((entry) => !entry.deleted).map((entry) => entry.path));
    const snapshot: RevisionSnapshot = {
      schemaVersion: REVISION_SCHEMA_VERSION,
      currentSequence: sequence,
      entries: list.sort((a, b) => a.path.localeCompare(b.path)),
      updatedAt: new Date().toISOString(),
    };
    await this.ensureStore();
    await this.store!.write(snapshot);
    this.persistedSequence = snapshot.currentSequence;
    this.unflushedEvents = 0;
    this.snapshot = snapshot;
    this.initializeMaps(snapshot.entries);
    return snapshot;
  }

  private async ensureStore(): Promise<void> {
    if (this.store) return;
    const paths = await ensureSyncStorage(this.dataDir);
    this.store = new AtomicJsonStore(path.join(paths.root, 'revisions.json'), RevisionSnapshotSchema);
  }
}

export async function scanVaultSnapshot(
  vaultRoot: string,
  resumedEntries: readonly SyncEntry[] = [],
  checkpoint?: (entries: SyncEntry[]) => Promise<void>,
): Promise<SyncEntry[]> {
  const root = await fs.realpath(vaultRoot);
  const entries: SyncEntry[] = [];
  const resumedByPath = new Map(resumedEntries.map((entry) => [entry.path, entry]));

  async function walk(absoluteDirectory: string, relativeDirectory: string): Promise<void> {
    const children = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const policy = evaluatePathPolicy(relative.normalize('NFC'));
      if (!policy.allowed) continue;
      const absolute = path.join(absoluteDirectory, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        const stat = await fs.stat(absolute);
        const resumed = resumedByPath.get(policy.path);
        entries.push(makeEntry(policy.path, 'directory', null, 0, stat.mtime, resumed?.entryId));
        if (checkpoint && entries.length % 5_000 === 0) await checkpoint([...entries]);
        await walk(absolute, policy.path);
      } else if (child.isFile()) {
        const stat = await fs.stat(absolute);
        const resumed = resumedByPath.get(policy.path);
        if (resumed?.kind === 'file' && resumed.size === stat.size && resumed.modifiedAt === stat.mtime.toISOString()) {
          entries.push(resumed);
        } else {
          const stable = await stableFileHash(absolute);
          entries.push(makeEntry(policy.path, 'file', stable.hash, stable.size, stable.mtime, resumed?.entryId));
        }
        if (checkpoint && entries.length % 5_000 === 0) await checkpoint([...entries]);
      }
    }
  }

  await walk(root, '');
  if (checkpoint) await checkpoint([...entries]);
  assertNoCaseFoldCollision(entries.map((entry) => entry.path));
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function makeEntry(
  relativePath: string,
  kind: 'file' | 'directory',
  hash: string | null,
  size: number,
  modifiedAt: Date,
  entryId = `entry_${randomBytes(18).toString('base64url')}`,
): SyncEntry {
  return {
    entryId,
    path: relativePath,
    kind,
    revision: 1,
    hash,
    size,
    modifiedAt: modifiedAt.toISOString(),
    deleted: false,
    sequence: 0,
  };
}

function foldPath(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

async function stableFileHash(file: string): Promise<{ hash: string; size: number; mtime: Date }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await fs.stat(file);
    const hash = await sha256Chunks(createReadStream(file));
    const after = await fs.stat(file);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return { hash, size: after.size, mtime: after.mtime };
    }
  }
  throw new Error(`file changed repeatedly during sync bootstrap: ${file}`);
}

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256Chunks } from '@webobsidian/sync-core';
import { MergeBaseStore } from './base-store.js';
import { BlobStore } from './blob-store.js';
import { TransactionIntentStore } from './intents.js';
import { JournalStore } from './journal.js';
import { RevisionStore } from './revision-store.js';
import { ensureSyncStorage } from './storage.js';
import { VaultStateStore } from './vault-state.js';

export interface DoctorIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
  repairable: boolean;
  repaired: boolean;
}
export interface DoctorReport {
  healthy: boolean;
  readOnlyRecommended: boolean;
  latestSequence: number | null;
  checkedEntries: number;
  checkedBlobs: number;
  issues: DoctorIssue[];
}
export interface DoctorOptions { repair?: boolean; now?: Date; uploadExpiryMs?: number; orphanGraceMs?: number }

export class SyncDoctor {
  constructor(private readonly dataDir: string, private readonly vaultRoot: string) {}

  async run(options: DoctorOptions = {}): Promise<DoctorReport> {
    const issues: DoctorIssue[] = [];
    const now = options.now ?? new Date();
    const uploadExpiryMs = options.uploadExpiryMs ?? 24 * 60 * 60 * 1000;
    const orphanGraceMs = options.orphanGraceMs ?? 90 * 24 * 60 * 60 * 1000;
    let latestSequence: number | null = null;
    let checkedEntries = 0;
    let checkedBlobs = 0;
    let events = [] as Awaited<ReturnType<JournalStore['replay']>>;
    let snapshot: Awaited<ReturnType<RevisionStore['load']>> = null;

    try {
      events = await new JournalStore(this.dataDir).replay();
      latestSequence = events.at(-1)?.sequence ?? 0;
    } catch (error) {
      issues.push(issue('error', 'journal_corrupt', error, undefined, false));
    }
    try {
      snapshot = await new RevisionStore(this.dataDir).load();
      const vault = await new VaultStateStore(this.dataDir).loadOrCreate();
      if (!snapshot) issues.push(issue('error', 'revisions_missing', 'revision snapshot is missing', undefined, false));
      else if (latestSequence !== null && snapshot.currentSequence !== latestSequence) {
        issues.push(issue('error', 'sequence_divergence', `revision sequence ${snapshot.currentSequence} != journal ${latestSequence}`, undefined, false));
      }
      if (latestSequence !== null && vault.currentSequence !== latestSequence) {
        issues.push(issue('error', 'vault_sequence_divergence', `vault sequence ${vault.currentSequence} != journal ${latestSequence}`, undefined, false));
      }
    } catch (error) {
      issues.push(issue('error', 'metadata_corrupt', error, undefined, false));
    }

    if (snapshot) {
      const root = await fs.realpath(this.vaultRoot);
      const latestByEntry = new Map<string, (typeof events)[number]>();
      for (const event of events) latestByEntry.set(event.entryId, event);
      for (const entry of snapshot.entries) {
        checkedEntries += 1;
        const lastEvent = latestByEntry.get(entry.entryId);
        if (lastEvent && (entry.revision < lastEvent.revision || entry.sequence < lastEvent.sequence)) {
          issues.push(issue('error', 'revision_projection_stale', `entry projection trails event ${lastEvent.eventId}`, entry.path, false));
        }
        if (entry.deleted) continue;
        const absolute = path.resolve(root, ...entry.path.split('/'));
        if (!absolute.startsWith(`${root}${path.sep}`)) {
          issues.push(issue('error', 'path_escape', 'entry escapes vault root', entry.path, false));
          continue;
        }
        try {
          const stat = await fs.lstat(absolute);
          if (entry.kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
            issues.push(issue('error', 'kind_mismatch', `expected ${entry.kind}`, entry.path, false));
          } else if (entry.kind === 'file') {
            const hash = await sha256Chunks(createReadStream(absolute));
            if (hash !== entry.hash || stat.size !== entry.size) {
              issues.push(issue('error', 'filesystem_divergence', 'file hash/size differs from revision state', entry.path, false));
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') issues.push(issue('error', 'entry_missing', 'live entry is missing', entry.path, false));
          else issues.push(issue('error', 'entry_unreadable', error, entry.path, false));
        }
      }
    }

    const referenced = new Set<string>();
    for (const entry of snapshot?.entries ?? []) if (entry.hash) referenced.add(entry.hash);
    for (const event of events) {
      if (event.hash) referenced.add(event.hash);
      if (event.previousHash) referenced.add(event.previousHash);
    }
    try {
      const bases = new MergeBaseStore(this.dataDir);
      for (const base of await bases.list()) {
        referenced.add(base.hash);
        if (!(await bases.get(base.entryId, base.revision))) {
          issues.push(issue('error', 'base_blob_missing', `merge base blob ${base.hash} is missing`, undefined, false));
        }
      }
      const blobs = new BlobStore(this.dataDir);
      for (const blob of await blobs.list()) {
        checkedBlobs += 1;
        if (referenced.has(blob.hash)) continue;
        const stat = await fs.stat(blob.file);
        const repairable = stat.mtime.getTime() < now.getTime() - orphanGraceMs;
        let repaired = false;
        if (repairable && options.repair) { await fs.unlink(blob.file); repaired = true; }
        issues.push({ severity: 'warning', code: 'orphan_blob', message: `unreferenced blob ${blob.hash}`, path: blob.file, repairable, repaired });
      }
    } catch (error) {
      issues.push(issue('error', 'blob_or_base_corrupt', error, undefined, false));
    }

    try {
      for (const intent of await new TransactionIntentStore(this.dataDir).list()) {
        issues.push(issue('error', 'pending_transaction', `transaction ${intent.transactionId} requires coordinator recovery`, undefined, false));
      }
      const paths = await ensureSyncStorage(this.dataDir);
      for (const child of await fs.readdir(paths.uploads, { withFileTypes: true })) {
        if (!child.isFile()) continue;
        const file = path.join(paths.uploads, child.name);
        const expired = (await fs.stat(file)).mtime.getTime() < now.getTime() - uploadExpiryMs;
        if (!expired) continue;
        if (options.repair) await fs.unlink(file);
        issues.push({ severity: 'warning', code: 'expired_upload', message: 'expired incomplete upload', path: file, repairable: true, repaired: Boolean(options.repair) });
      }
    } catch (error) {
      issues.push(issue('error', 'transaction_or_upload_corrupt', error, undefined, false));
    }

    const unrepairedErrors = issues.some((item) => item.severity === 'error' && !item.repaired);
    return {
      healthy: !unrepairedErrors && !issues.some((item) => !item.repaired),
      readOnlyRecommended: unrepairedErrors,
      latestSequence,
      checkedEntries,
      checkedBlobs,
      issues,
    };
  }
}

function issue(
  severity: DoctorIssue['severity'],
  code: string,
  value: unknown,
  issuePath: string | undefined,
  repairable: boolean,
): DoctorIssue {
  return {
    severity, code,
    message: value instanceof Error ? value.message : String(value),
    ...(issuePath ? { path: issuePath } : {}),
    repairable,
    repaired: false,
  };
}

import { randomBytes } from 'node:crypto';
import type { SyncEntry } from '@picassio/sync-core';

interface Snapshot { snapshotId: string; sequence: number; entries: SyncEntry[]; expiresAt: number }
interface Cursor { snapshotId: string; offset: number }

export class ManifestExpiredError extends Error {
  readonly code = 'manifest_expired';
  constructor() { super('Manifest snapshot or cursor expired'); this.name = 'ManifestExpiredError'; }
}

export class ManifestSnapshotStore {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly cursors = new Map<string, Cursor>();
  constructor(private readonly ttlMs = 15 * 60 * 1000) {}

  create(entries: SyncEntry[], sequence: number, limit: number) {
    this.prune();
    const snapshotId = `snapshot_${randomBytes(18).toString('base64url')}`;
    this.snapshots.set(snapshotId, {
      snapshotId, sequence,
      entries: entries.map((entry) => ({ ...entry })),
      expiresAt: Date.now() + this.ttlMs,
    });
    return this.pageSnapshot(snapshotId, 0, limit);
  }

  page(cursor: string, limit: number) {
    this.prune();
    const position = this.cursors.get(cursor);
    if (!position) throw new ManifestExpiredError();
    return this.pageSnapshot(position.snapshotId, position.offset, limit);
  }

  private pageSnapshot(snapshotId: string, offset: number, limit: number) {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.expiresAt <= Date.now()) throw new ManifestExpiredError();
    const entries = snapshot.entries.slice(offset, offset + limit);
    const nextOffset = offset + entries.length;
    let nextCursor: string | null = null;
    if (nextOffset < snapshot.entries.length) {
      nextCursor = `cursor_${randomBytes(24).toString('base64url')}`;
      this.cursors.set(nextCursor, { snapshotId, offset: nextOffset });
    }
    return { snapshotId, snapshotSequence: snapshot.sequence, entries, nextCursor };
  }

  private prune(): void {
    const now = Date.now();
    const expired = new Set<string>();
    for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= now) { this.snapshots.delete(id); expired.add(id); }
    for (const [cursor, position] of this.cursors) if (expired.has(position.snapshotId)) this.cursors.delete(cursor);
  }
}

export const manifestSnapshots = new ManifestSnapshotStore();

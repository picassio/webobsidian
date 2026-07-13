import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertServerPathAllowed, type OrderedSyncClient, type SyncOperation } from '@webobsidian/sync-core';
import { FilesystemAdapter } from './fs-adapter.js';
import { HeadlessStore, type PendingPath } from './state.js';
import { NodeSyncTransport } from './transport.js';

export class FilesystemMutationQueue {
  constructor(
    private readonly store: HeadlessStore,
    private readonly adapter: FilesystemAdapter,
    private readonly transport: NodeSyncTransport,
    private readonly engine: OrderedSyncClient,
  ) {}
  async observe(pending: PendingPath): Promise<void> {
    if (this.store.state.mode === 'pull-only') return;
    await this.store.queuePath(pending);
  }
  async scan(): Promise<void> {
    if (this.store.state.mode === 'pull-only') return;
    const seen = new Set<string>();
    for (const item of await this.adapter.scan()) {
      seen.add(item.path); const projected = this.store.entryByPath(item.path);
      if (!projected || projected.kind !== item.kind || projected.hash !== item.hash) {
        await this.observe({ path: item.path, action: 'upsert', observedAt: new Date().toISOString() });
      }
    }
    for (const entry of this.store.state.entries) {
      if (!entry.deleted && !seen.has(entry.path)) await this.observe({ path: entry.path, action: 'delete', observedAt: new Date().toISOString() });
    }
  }
  async flushAll(): Promise<void> {
    if (this.store.state.mode === 'pull-only') return;
    for (const pending of [...this.store.state.pendingPaths]) await this.flush(pending);
  }
  private async flush(pending: PendingPath): Promise<void> {
    assertServerPathAllowed(pending.path);
    const sequence = await this.store.takeClientSequence(); const key = `headless-${sequence}-${randomId()}`;
    let operation: SyncOperation | null = null;
    if (pending.action === 'delete') {
      const entry = this.store.entryByPath(pending.path);
      if (entry) operation = { operation: entry.kind === 'directory' ? 'rmdir' : 'delete', entryId: entry.entryId, baseRevision: entry.revision, clientSequence: sequence, idempotencyKey: key };
    } else if (pending.action === 'rename') {
      const entry = pending.oldPath ? this.store.entryByPath(pending.oldPath) : null;
      if (entry) operation = { operation: 'rename', entryId: entry.entryId, baseRevision: entry.revision, path: pending.path, clientSequence: sequence, idempotencyKey: key };
    } else {
      const absolute = path.join(this.store.state.vaultPath, ...pending.path.split('/'));
      let stat;
      try { stat = await fs.lstat(absolute); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { await this.store.removePendingPath(pending.path); return; }
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed: ${pending.path}`);
      const entry = this.store.entryByPath(pending.path);
      if (stat.isDirectory()) {
        if (!entry) operation = { operation: 'mkdir', path: pending.path, kind: 'directory', clientSequence: sequence, idempotencyKey: key };
      } else if (stat.isFile()) {
        const content = await this.adapter.hash(pending.path);
        if (await this.adapter.consumeExpected(pending.path, content.hash) || entry?.hash === content.hash) {
          await this.store.removePendingPath(pending.path); return;
        }
        const reference = content.size === 0 ? { hash: content.hash, size: 0, inlineText: '' } : { hash: content.hash, size: content.size, blobHash: content.hash };
        if (content.size > 0) await this.transport.uploadFile(absolute, content.hash, content.size);
        operation = entry
          ? { operation: 'modify', entryId: entry.entryId, baseRevision: entry.revision, clientSequence: sequence, idempotencyKey: key, content: reference }
          : { operation: 'create', path: pending.path, kind: 'file', clientSequence: sequence, idempotencyKey: key, content: reference };
      }
    }
    if (operation) await this.engine.queue(operation);
    await this.store.removePendingPath(pending.path);
  }
}
function randomId() { return Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('hex'); }

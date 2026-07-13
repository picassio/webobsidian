import { OrderedSyncClient, type OperationResult, type SyncConnectionStatus } from '@picassio/sync-core';
import { FilesystemAdapter } from './fs-adapter.js';
import { FilesystemMutationQueue } from './local-queue.js';
import { HeadlessStore } from './state.js';
import { NodeSyncTransport } from './transport.js';
import { acquireInstanceLock, VaultWatcher } from './watcher.js';

export interface ClientStatus {
  status: SyncConnectionStatus;
  lag: number;
  cursor: number;
  queuedOperations: number;
  pendingPaths: number;
  conflicts: number;
  mode: string;
  lastSyncAt: string | null;
  lastError: string | null;
}
export class HeadlessClient {
  readonly transport: NodeSyncTransport;
  readonly adapter: FilesystemAdapter;
  readonly engine: OrderedSyncClient;
  readonly queue: FilesystemMutationQueue;
  private watcher: VaultWatcher | null = null;
  private releaseLock: (() => Promise<void>) | null = null;
  private connection: SyncConnectionStatus = 'offline';
  private lag = 0;
  private conflictCount = 0;
  constructor(readonly store: HeadlessStore, token: string, private readonly log: (level: 'info' | 'error', message: string, metadata?: object) => void) {
    this.transport = new NodeSyncTransport(store.state.serverUrl, token);
    this.adapter = new FilesystemAdapter(store, this.transport, (result) => this.conflict(result));
    this.engine = new OrderedSyncClient(store, this.transport, this.adapter, (status, lag) => {
      this.connection = this.conflictCount > 0 && status === 'synced' ? 'conflict' : status;
      this.lag = lag; this.log('info', 'sync status changed', { status: this.connection, lag });
    }, undefined, store.state.pollSeconds * 1_000);
    this.queue = new FilesystemMutationQueue(store, this.adapter, this.transport, this.engine);
  }
  async initialize(): Promise<void> { await this.adapter.initialize(); }
  async syncOnce(): Promise<ClientStatus> {
    await this.adapter.reconcilePullOnly();
    await this.queue.scan(); await this.queue.flushAll();
    try {
      await this.engine.start();
      await this.refreshConflicts();
      await this.store.update((state) => { state.lastSyncAt = new Date().toISOString(); state.lastError = null; });
    } catch (error) {
      await this.store.update((state) => { state.lastError = sanitize(error); }); throw error;
    } finally { this.engine.stop(); }
    return this.status();
  }
  async watch(polling = false): Promise<void> {
    this.releaseLock = await acquireInstanceLock(this.store);
    await this.adapter.reconcilePullOnly();
    await this.queue.scan(); await this.queue.flushAll(); await this.engine.start(); await this.refreshConflicts();
    this.watcher = new VaultWatcher(this.store, this.adapter, this.queue); await this.watcher.start(polling);
    this.log('info', 'watch daemon ready', { mode: this.store.state.mode, polling });
  }
  async stop(): Promise<void> {
    await this.queue.flushAll().catch(() => {}); await this.watcher?.close(); this.engine.stop();
    await this.releaseLock?.(); this.releaseLock = null; this.watcher = null;
  }
  status(): ClientStatus {
    return {
      status: this.connection, lag: this.lag, cursor: this.store.state.cursor,
      queuedOperations: this.store.state.operations.length, pendingPaths: this.store.state.pendingPaths.length,
      conflicts: this.conflictCount, mode: this.store.state.mode,
      lastSyncAt: this.store.state.lastSyncAt, lastError: this.store.state.lastError,
    };
  }
  private async refreshConflicts(): Promise<void> {
    this.conflictCount = (await this.transport.conflicts()).filter((item) => item.status === 'unresolved').length;
    if (this.conflictCount > 0) this.connection = 'conflict';
  }
  private conflict(result: OperationResult | string): void {
    this.conflictCount += 1; this.connection = 'conflict';
    this.log('error', 'sync conflict preserved both versions', typeof result === 'string' ? { detail: result } : { conflictId: result.conflictId, errorCode: result.errorCode });
  }
}
export async function openClient(store: HeadlessStore, logger: HeadlessClient['log']): Promise<HeadlessClient> {
  const token = await store.token(); if (!token) throw new Error('device is not paired; run pair or provide WEB_VAULT_SYNC_TOKEN');
  const client = new HeadlessClient(store, token, logger); await client.initialize(); return client;
}
function sanitize(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/gi, 'Bearer <redacted>'); }

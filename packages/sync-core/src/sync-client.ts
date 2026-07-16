import { DEFAULT_LIMITS, type OperationResult, type SyncEntry, type SyncEvent, type SyncOperation } from './schemas.js';

export type SyncConnectionStatus = 'disabled' | 'syncing' | 'synced' | 'offline' | 'conflict' | 'error';
export interface ClientDeviceIdentity {
  deviceId: string;
  deviceName: string;
  /** Adapter-owned credential metadata; browser httpOnly-cookie clients intentionally omit it. */
  token?: string;
  vaultId: string;
  cursor: number;
}
export interface ClientApplyIntent { event: SyncEvent; createdAt: string }
export interface SyncClientPersistence {
  getDevice(): Promise<ClientDeviceIdentity | null>;
  putCursor(cursor: number): Promise<void>;
  operations(): Promise<SyncOperation[]>;
  putOperation(operation: SyncOperation): Promise<void>;
  removeOperation(idempotencyKey: string): Promise<void>;
  /** Optional atomic fast path; replay remains safe if a crash occurs before this durable removal. */
  removeOperations?(idempotencyKeys: string[]): Promise<void>;
  putApplyIntent(intent: ClientApplyIntent): Promise<void>;
  removeApplyIntent(eventId: string): Promise<void>;
  applyIntents(): Promise<ClientApplyIntent[]>;
}
export interface SyncClientTransport {
  handshake(device: ClientDeviceIdentity): Promise<{
    vaultId: string;
    latestSequence: number;
    minimumRetainedSequence: number;
    readOnly: boolean;
    limits?: { maxOperationsPerBatch: number };
    capabilities?: string[];
  }>;
  manifest(): Promise<{ entries: SyncEntry[]; snapshotSequence: number }>;
  changes(after: number, limit: number): Promise<{ events: SyncEvent[]; nextAfter: number; hasMore: boolean; latestSequence: number }>;
  acknowledge(sequence: number): Promise<void>;
  operations(operations: SyncOperation[]): Promise<OperationResult[]>;
  connectWake(wake: () => void, closed: () => void): Promise<() => void>;
}
export interface SyncLocalAdapter {
  apply(event: SyncEvent): Promise<void>;
  recover(intent: ClientApplyIntent): Promise<void>;
  bootstrap(entries: SyncEntry[]): Promise<void>;
  committed?(operation: SyncOperation, result: OperationResult): Promise<void>;
  conflict(result: OperationResult): Promise<void>;
}
export interface SyncClientScheduler {
  timeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  interval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
  random(): number;
}
export interface SyncClientLifecycleOptions {
  /** Runs after successful recovery materialization and apply-intent removal; recovery need not advance the cursor. */
  onRecoveryComplete?(event: SyncEvent): Promise<void> | void;
  /** Runs once after all retained apply intents have been recovered. */
  afterRecovery?(): Promise<void>;
  /** Runs after manifest fetch but before any remote snapshot bytes are materialized locally. */
  beforeBootstrap?(snapshot: { entries: SyncEntry[]; snapshotSequence: number }): Promise<void>;
  /** Runs after optional bootstrap cursor persistence and before durable local operations are published. */
  beforeInitialFlush?(): Promise<void>;
  /** Runs only after accepted/merged/conflict handling and durable queue removal. */
  onOperationDurable?(operation: SyncOperation, result: OperationResult): Promise<void> | void;
  /** Runs after the initial local flush and immediately before remote catch-up. */
  beforeInitialCatchUp?(): Promise<void>;
  /** Runs only after normal catch-up apply-intent removal and durable cursor persistence. */
  onEventDurable?(event: SyncEvent): Promise<void> | void;
}

const defaultScheduler: SyncClientScheduler = {
  timeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  interval: (callback, delay) => globalThis.setInterval(callback, delay),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  random: () => Math.random(),
};

/** Shared crash-safe ordered catch-up/queue state machine used by every Sync v1 client adapter. */
export class OrderedSyncClient {
  private running = false;
  private catchingUp: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  private closeWake: (() => void) | null = null;
  private pollTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private reconnectAttempt = 0;
  private maxOperationsPerBatch = 1;

  constructor(
    private readonly persistence: SyncClientPersistence,
    private readonly transport: SyncClientTransport,
    private readonly adapter: SyncLocalAdapter,
    private readonly onStatus: (status: SyncConnectionStatus, lag: number) => void,
    private readonly scheduler: SyncClientScheduler = defaultScheduler,
    private readonly pollMs = 15_000,
    private readonly lifecycle: SyncClientLifecycleOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const device = await this.persistence.getDevice();
    if (!device) { this.onStatus('disabled', 0); return; }
    this.onStatus('syncing', 0);
    try {
      for (const intent of await this.persistence.applyIntents()) {
        await this.adapter.recover(intent);
        await this.persistence.removeApplyIntent(intent.event.eventId);
        await this.lifecycle.onRecoveryComplete?.(intent.event);
      }
      await this.lifecycle.afterRecovery?.();
      const handshake = await this.transport.handshake(device);
      if (handshake.vaultId !== device.vaultId) throw new Error('paired vault identity changed');
      const advertisedBatchLimit = handshake.limits?.maxOperationsPerBatch ?? DEFAULT_LIMITS.maxOperationsPerBatch;
      if (!Number.isSafeInteger(advertisedBatchLimit) || advertisedBatchLimit < 1) {
        throw new Error('invalid maxOperationsPerBatch handshake limit');
      }
      // Older Protocol 1.0 servers continue processing independent rows after a rejection. Batched publication is
      // safe only when the server promises to stop the remainder, otherwise a later accepted client sequence could
      // make an earlier retained rejection impossible to retry.
      this.maxOperationsPerBatch = handshake.capabilities?.includes('ordered-batch-stop-v1')
        ? Math.min(DEFAULT_LIMITS.maxOperationsPerBatch, advertisedBatchLimit)
        : 1;
      if (device.cursor === 0 || device.cursor < handshake.minimumRetainedSequence - 1) {
        const snapshot = await this.transport.manifest();
        await this.lifecycle.beforeBootstrap?.(snapshot);
        await this.adapter.bootstrap(snapshot.entries);
        await this.persistence.putCursor(snapshot.snapshotSequence);
      }
      await this.lifecycle.beforeInitialFlush?.();
      // Publish durable local work before pulling newer remote bytes; stale bases then resolve through
      // the server conflict matrix instead of a catch-up silently replacing an offline edit.
      await this.flush();
      await this.lifecycle.beforeInitialCatchUp?.();
      await this.catchUp();
      await this.connectWake();
      this.reconnectAttempt = 0;
    } catch (error) {
      this.onStatus('offline', 0);
      this.scheduleReconnect();
      throw error;
    }
  }

  stop(): void {
    this.running = false;
    this.closeWake?.();
    this.closeWake = null;
    if (this.pollTimer !== null) this.scheduler.clearInterval(this.pollTimer);
    if (this.reconnectTimer !== null) this.scheduler.clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.reconnectTimer = null;
  }

  async enqueue(operation: SyncOperation): Promise<void> {
    await this.persistence.putOperation(operation);
  }

  async queue(operation: SyncOperation): Promise<void> {
    await this.enqueue(operation);
    if (this.running) await this.flush().catch(() => this.onStatus('offline', 0));
  }

  async catchUp(): Promise<void> {
    if (this.catchingUp) return this.catchingUp;
    this.catchingUp = this.catchUpLoop().finally(() => { this.catchingUp = null; });
    return this.catchingUp;
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushLoop().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async flushLoop(): Promise<void> {
    const queued = (await this.persistence.operations()).sort((a, b) => a.clientSequence - b.clientSequence);
    for (let offset = 0; offset < queued.length; offset += this.maxOperationsPerBatch) {
      const batch = queued.slice(offset, offset + this.maxOperationsPerBatch);
      const expectedKeys = new Set(batch.map((operation) => operation.idempotencyKey));
      if (expectedKeys.size !== batch.length) throw new Error('queued operation idempotency keys must be unique');

      const results = await this.transport.operations(batch);
      const resultsByKey = new Map(results.map((result) => [result.idempotencyKey, result]));
      const hasExactCoverage = results.length === batch.length
        && resultsByKey.size === batch.length
        && results.every((result) => expectedKeys.has(result.idempotencyKey));
      if (!hasExactCoverage) throw new Error('operation results must exactly cover the published batch');

      let stopAfterBatch = false;
      const durable: Array<{ operation: SyncOperation; result: OperationResult }> = [];
      for (const operation of batch) {
        const result = resultsByKey.get(operation.idempotencyKey)!;
        if (result.status === 'accepted' || result.status === 'merged') {
          await this.adapter.committed?.(operation, result);
          durable.push({ operation, result });
        } else if (result.status === 'conflict') {
          await this.adapter.conflict(result);
          durable.push({ operation, result });
          this.onStatus('conflict', 0);
        } else {
          if (result.status === 'rejected') await this.adapter.conflict(result);
          this.onStatus('conflict', 0);
          stopAfterBatch = true;
        }
      }
      if (durable.length > 0 && this.persistence.removeOperations) {
        await this.persistence.removeOperations(durable.map(({ operation }) => operation.idempotencyKey));
        for (const item of durable) await this.lifecycle.onOperationDurable?.(item.operation, item.result);
      } else {
        for (const item of durable) {
          await this.persistence.removeOperation(item.operation.idempotencyKey);
          await this.lifecycle.onOperationDurable?.(item.operation, item.result);
        }
      }
      if (stopAfterBatch) return;
    }
  }

  private async catchUpLoop(): Promise<void> {
    const device = await this.persistence.getDevice();
    if (!device) return;
    let cursor = device.cursor;
    let latest = cursor;
    this.onStatus('syncing', 0);
    do {
      const page = await this.transport.changes(cursor, 500);
      latest = page.latestSequence;
      for (const event of page.events) {
        const intent = { event, createdAt: new Date().toISOString() };
        await this.persistence.putApplyIntent(intent);
        await this.adapter.apply(event);
        await this.persistence.removeApplyIntent(event.eventId);
        cursor = event.sequence;
        await this.persistence.putCursor(cursor);
        await this.lifecycle.onEventDurable?.(event);
      }
      if (!page.hasMore) break;
    } while (true);
    await this.transport.acknowledge(cursor);
    this.onStatus('synced', Math.max(0, latest - cursor));
  }

  private async connectWake(): Promise<void> {
    this.closeWake = await this.transport.connectWake(
      () => { void this.flush().then(() => this.catchUp()).catch(() => this.onStatus('offline', 0)); },
      () => { if (this.running) this.scheduleReconnect(); },
    );
    if (this.pollTimer === null) {
      this.pollTimer = this.scheduler.interval(() => {
        if (this.running) void this.flush().then(() => this.catchUp()).catch(() => this.onStatus('offline', 0));
      }, this.pollMs);
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== null) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt++, 6));
    this.reconnectTimer = this.scheduler.timeout(() => {
      this.reconnectTimer = null;
      this.running = false;
      void this.start().catch(() => this.scheduleReconnect());
    }, delay + Math.floor(this.scheduler.random() * Math.max(1, delay / 4)));
  }
}

import type { OperationResult, SyncEntry, SyncEvent, SyncOperation } from './schemas.js';

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
  putApplyIntent(intent: ClientApplyIntent): Promise<void>;
  removeApplyIntent(eventId: string): Promise<void>;
  applyIntents(): Promise<ClientApplyIntent[]>;
}
export interface SyncClientTransport {
  handshake(device: ClientDeviceIdentity): Promise<{ vaultId: string; latestSequence: number; minimumRetainedSequence: number; readOnly: boolean }>;
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
  conflict(result: OperationResult): Promise<void>;
}
export interface SyncClientScheduler {
  timeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  interval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
  random(): number;
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

  constructor(
    private readonly persistence: SyncClientPersistence,
    private readonly transport: SyncClientTransport,
    private readonly adapter: SyncLocalAdapter,
    private readonly onStatus: (status: SyncConnectionStatus, lag: number) => void,
    private readonly scheduler: SyncClientScheduler = defaultScheduler,
    private readonly pollMs = 15_000,
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
      }
      const handshake = await this.transport.handshake(device);
      if (handshake.vaultId !== device.vaultId) throw new Error('paired vault identity changed');
      if (device.cursor === 0 || device.cursor < handshake.minimumRetainedSequence - 1) {
        const snapshot = await this.transport.manifest();
        await this.adapter.bootstrap(snapshot.entries);
        await this.persistence.putCursor(snapshot.snapshotSequence);
      }
      // Publish durable local work before pulling newer remote bytes; stale bases then resolve through
      // the server conflict matrix instead of a catch-up silently replacing an offline edit.
      await this.flush();
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

  async queue(operation: SyncOperation): Promise<void> {
    await this.persistence.putOperation(operation);
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
    for (const operation of queued) {
      const [result] = await this.transport.operations([operation]);
      if (!result) throw new Error('operation result missing');
      if (result.status === 'accepted' || result.status === 'merged') {
        await this.persistence.removeOperation(operation.idempotencyKey);
      } else if (result.status === 'conflict') {
        await this.adapter.conflict(result);
        await this.persistence.removeOperation(operation.idempotencyKey);
        this.onStatus('conflict', 0);
      } else if (result.status === 'rejected') {
        await this.adapter.conflict(result);
        this.onStatus('conflict', 0);
        return;
      }
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
      }
      if (!page.hasMore) break;
    } while (true);
    await this.transport.acknowledge(cursor);
    this.onStatus('synced', Math.max(0, latest - cursor));
  }

  private async connectWake(): Promise<void> {
    this.closeWake = await this.transport.connectWake(
      () => { void this.catchUp().then(() => this.flush()).catch(() => this.onStatus('offline', 0)); },
      () => { if (this.running) this.scheduleReconnect(); },
    );
    if (this.pollTimer === null) {
      this.pollTimer = this.scheduler.interval(() => {
        if (this.running) void this.catchUp().catch(() => this.onStatus('offline', 0));
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

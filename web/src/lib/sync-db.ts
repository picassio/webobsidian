import type { SyncEvent, SyncOperation } from '@picassio/sync-core';

export interface BrowserDeviceState {
  deviceId: string;
  deviceName: string;
  vaultId: string;
  cursor: number;
  nextClientSequence: number;
}
export interface LocalApplyIntent { event: SyncEvent; createdAt: string }
export interface PendingAttachment {
  idempotencyKey: string;
  clientSequence: number;
  path: string;
  hash: string;
  size: number;
  blob: Blob;
  createdAt: string;
}
export interface LocalEntryProjection {
  entryId: string;
  path: string;
  revision: number;
  hash: string | null;
  size: number;
  deleted: boolean;
}
export interface PersistedDraft {
  path: string;
  entryId: string | null;
  revision: number | null;
  hash: string | null;
  content: string;
  baseContent: string;
  dirtyGeneration: number;
  saveGeneration: number;
  savedAt: string;
}

export interface SyncPersistence {
  getDevice(): Promise<BrowserDeviceState | null>;
  putDevice(state: BrowserDeviceState): Promise<void>;
  putCursor(cursor: number): Promise<void>;
  takeClientSequence(): Promise<number>;
  operations(): Promise<SyncOperation[]>;
  attachments(): Promise<PendingAttachment[]>;
  putAttachment(attachment: PendingAttachment): Promise<void>;
  removeAttachment(idempotencyKey: string): Promise<void>;
  putOperation(operation: SyncOperation): Promise<void>;
  removeOperation(idempotencyKey: string): Promise<void>;
  putApplyIntent(intent: LocalApplyIntent): Promise<void>;
  removeApplyIntent(eventId: string): Promise<void>;
  applyIntents(): Promise<LocalApplyIntent[]>;
  putDraft(draft: PersistedDraft): Promise<void>;
  drafts(): Promise<PersistedDraft[]>;
  putEntry(entry: LocalEntryProjection): Promise<void>;
  entries(): Promise<LocalEntryProjection[]>;
  replaceEntries(entries: LocalEntryProjection[]): Promise<void>;
  getWorkspace<T>(): Promise<T | null>;
  putWorkspace<T>(workspace: T): Promise<void>;
  isWorkspaceMigrated(): Promise<boolean>;
  markWorkspaceMigrated(): Promise<void>;
}

type KvValue = BrowserDeviceState | SyncOperation | LocalApplyIntent | PendingAttachment | PersistedDraft | LocalEntryProjection | object | boolean;

export class IndexedDbSyncPersistence implements SyncPersistence {
  private database: Promise<IDBDatabase> | null = null;
  constructor(private readonly name = 'webobsidian-sync-v1') {}

  async getDevice(): Promise<BrowserDeviceState | null> {
    const stored = await this.get('device') as (BrowserDeviceState & { token?: string }) | null;
    if (!stored?.token) return stored;
    const { token: _discarded, ...sanitized } = stored;
    return sanitized;
  }
  async getLegacyDeviceToken(): Promise<string | null> {
    const stored = await this.get('device') as (BrowserDeviceState & { token?: string }) | null;
    return stored?.token ?? null;
  }
  async clearLegacyDeviceToken(): Promise<void> {
    const stored = await this.get('device') as (BrowserDeviceState & { token?: string }) | null;
    if (!stored?.token) return;
    const { token: _discarded, ...sanitized } = stored;
    await this.putDevice(sanitized);
  }
  async putDevice(state: BrowserDeviceState) { await this.put('device', state); }
  async clearDevice() { await this.remove('device'); }
  async putCursor(cursor: number) {
    const device = await this.getDevice();
    if (!device) throw new Error('browser sync device is not configured');
    await this.putDevice({ ...device, cursor });
  }
  async takeClientSequence(): Promise<number> {
    const transaction = (await this.open()).transaction('kv', 'readwrite', { durability: 'strict' });
    const store = transaction.objectStore('kv');
    const request = store.get('device');
    const sequence = await new Promise<number>((resolve, reject) => {
      request.onsuccess = () => {
        const device = request.result as BrowserDeviceState | undefined;
        if (!device) { transaction.abort(); reject(new Error('browser sync device is not configured')); return; }
        const current = device.nextClientSequence ?? 1;
        store.put({ ...device, nextClientSequence: current + 1 }, 'device');
        resolve(current);
      };
      request.onerror = () => reject(request.error);
    });
    await transactionPromise(transaction);
    return sequence;
  }
  async operations() { return this.values<SyncOperation>('operation:'); }
  async attachments() { return this.values<PendingAttachment>('attachment:'); }
  async putAttachment(attachment: PendingAttachment) { await this.put(`attachment:${attachment.idempotencyKey}`, attachment); }
  async removeAttachment(idempotencyKey: string) { await this.remove(`attachment:${idempotencyKey}`); }
  async putOperation(operation: SyncOperation) { await this.put(`operation:${operation.idempotencyKey}`, operation); }
  async removeOperation(idempotencyKey: string) { await this.remove(`operation:${idempotencyKey}`); }
  async putApplyIntent(intent: LocalApplyIntent) { await this.put(`apply:${intent.event.eventId}`, intent); }
  async removeApplyIntent(eventId: string) { await this.remove(`apply:${eventId}`); }
  async applyIntents() { return this.values<LocalApplyIntent>('apply:'); }
  async putDraft(draft: PersistedDraft) { await this.put(`draft:${draft.path}`, draft); }
  async drafts() { return this.values<PersistedDraft>('draft:'); }
  async putEntry(entry: LocalEntryProjection) { await this.put(`entry:${entry.entryId}`, entry); }
  async entries() { return this.values<LocalEntryProjection>('entry:'); }
  async replaceEntries(entries: LocalEntryProjection[]): Promise<void> {
    const transaction = (await this.open()).transaction('kv', 'readwrite', { durability: 'strict' });
    const store = transaction.objectStore('kv');
    const keys = await requestPromise<IDBValidKey[]>(store.getAllKeys(IDBKeyRange.bound('entry:', 'entry:\uffff')));
    for (const key of keys) store.delete(key);
    for (const entry of entries) store.put(entry, `entry:${entry.entryId}`);
    await transactionPromise(transaction);
  }
  async getWorkspace<T>() { return (await this.get('workspace')) as T | null; }
  async putWorkspace<T>(workspace: T) { await this.put('workspace', workspace as object); }
  async isWorkspaceMigrated() { return (await this.get('workspace:migrated')) === true; }
  async markWorkspaceMigrated() { await this.put('workspace:migrated', true); }

  private async open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('kv');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.database;
  }

  private async get(key: string): Promise<KvValue | null> {
    const request = (await this.open()).transaction('kv').objectStore('kv').get(key);
    return requestPromise<KvValue | undefined>(request).then((value) => value ?? null);
  }
  private async put(key: string, value: KvValue): Promise<void> {
    const transaction = (await this.open()).transaction('kv', 'readwrite', { durability: 'strict' });
    transaction.objectStore('kv').put(value, key);
    await transactionPromise(transaction);
  }
  private async remove(key: string): Promise<void> {
    const transaction = (await this.open()).transaction('kv', 'readwrite', { durability: 'strict' });
    transaction.objectStore('kv').delete(key);
    await transactionPromise(transaction);
  }
  private async values<T>(prefix: string): Promise<T[]> {
    const store = (await this.open()).transaction('kv').objectStore('kv');
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
    return requestPromise<T[]>(store.getAll(range));
  }
}

function transactionPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

function requestPromise<T = undefined>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

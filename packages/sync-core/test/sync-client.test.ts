import assert from 'node:assert/strict';
import test from 'node:test';
import { OrderedSyncClient, sha256Text, type ClientApplyIntent, type ClientDeviceIdentity, type SyncClientPersistence, type SyncClientTransport, type SyncLocalAdapter, type SyncOperation } from '../src/index.js';

class MemoryPersistence implements SyncClientPersistence {
  device: ClientDeviceIdentity = { deviceId: 'device_core_client_1', deviceName: 'Core test', token: 'secret', vaultId: 'vault_core_client_1', cursor: 5 };
  queued: SyncOperation[] = [];
  intents: ClientApplyIntent[] = [];
  async getDevice() { return this.device; }
  async putCursor(cursor: number) { this.device = { ...this.device, cursor }; }
  async operations() { return this.queued; }
  async putOperation(operation: SyncOperation) { this.queued.push(operation); }
  async removeOperation(key: string) { this.queued = this.queued.filter((item) => item.idempotencyKey !== key); }
  async putApplyIntent(intent: ClientApplyIntent) { this.intents = [intent]; }
  async removeApplyIntent() { this.intents = []; }
  async applyIntents() { return this.intents; }
}

test('ordered client publishes durable offline work before pulling remote bytes', async () => {
  const persistence = new MemoryPersistence();
  persistence.queued.push({
    operation: 'modify', entryId: 'entry_core_client_1', baseRevision: 1,
    clientSequence: 1, idempotencyKey: 'core-client-operation-1',
    content: { hash: sha256Text('local'), size: 5, inlineText: 'local' },
  });
  const order: string[] = [];
  const transport: SyncClientTransport = {
    async handshake() { return { vaultId: 'vault_core_client_1', latestSequence: 6, minimumRetainedSequence: 1, readOnly: false }; },
    async manifest() { return { entries: [], snapshotSequence: 5 }; },
    async operations(operations) { order.push('push'); return [{ idempotencyKey: operations[0]!.idempotencyKey, status: 'merged', sequence: 6 }]; },
    async changes(after) { order.push('pull'); return { events: [], nextAfter: after, hasMore: false, latestSequence: 6 }; },
    async acknowledge(sequence) { order.push(`ack:${sequence}`); },
    async connectWake() { return () => {}; },
  };
  const adapter: SyncLocalAdapter = {
    async apply() {}, async recover() {}, async bootstrap() {}, async conflict() {},
    async committed(operation, result) { order.push(`committed:${operation.idempotencyKey}:${result.status}`); },
  };
  const engine = new OrderedSyncClient(persistence, transport, adapter, () => {});
  await engine.start(); engine.stop();
  assert.deepEqual(order, ['push', 'committed:core-client-operation-1:merged', 'pull', 'ack:5']);
  assert.deepEqual(persistence.queued, []);
});

test('wake waits for durable local flush before pulling the echoed event', async () => {
  const persistence = new MemoryPersistence();
  let wake: (() => void) | null = null;
  let pulls = 0;
  let queuedAtWakePull = -1;
  const transport: SyncClientTransport = {
    async handshake() { return { vaultId: 'vault_core_client_1', latestSequence: 5, minimumRetainedSequence: 1, readOnly: false }; },
    async manifest() { return { entries: [], snapshotSequence: 5 }; },
    async operations(operations) {
      wake?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return [{ idempotencyKey: operations[0]!.idempotencyKey, status: 'accepted', sequence: 6 }];
    },
    async changes(after) {
      pulls += 1;
      if (pulls > 1) queuedAtWakePull = persistence.queued.length;
      return { events: [], nextAfter: after, hasMore: false, latestSequence: 6 };
    },
    async acknowledge() {},
    async connectWake(callback) { wake = callback; return () => {}; },
  };
  const adapter: SyncLocalAdapter = {
    async apply() {}, async recover() {}, async bootstrap() {}, async conflict() {},
  };
  const engine = new OrderedSyncClient(persistence, transport, adapter, () => {});
  await engine.start();
  await engine.queue({
    operation: 'modify', entryId: 'entry_core_client_1', baseRevision: 1,
    clientSequence: 1, idempotencyKey: 'core-client-wake-operation-1',
    content: { hash: sha256Text('local'), size: 5, inlineText: 'local' },
  });
  for (let attempt = 0; attempt < 20 && queuedAtWakePull < 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  engine.stop();
  assert.equal(queuedAtWakePull, 0);
});

test('enqueue durably stages an operation without publishing it', async () => {
  const persistence = new MemoryPersistence();
  let published = 0;
  const transport: SyncClientTransport = {
    async handshake() { return { vaultId: 'vault_core_client_1', latestSequence: 5, minimumRetainedSequence: 1, readOnly: false }; },
    async manifest() { return { entries: [], snapshotSequence: 5 }; },
    async operations(operations) { published += operations.length; return operations.map((operation) => ({ idempotencyKey: operation.idempotencyKey, status: 'accepted' as const, sequence: 6 })); },
    async changes(after) { return { events: [], nextAfter: after, hasMore: false, latestSequence: 5 }; },
    async acknowledge() {}, async connectWake() { return () => {}; },
  };
  const adapter: SyncLocalAdapter = { async apply() {}, async recover() {}, async bootstrap() {}, async conflict() {} };
  const engine = new OrderedSyncClient(persistence, transport, adapter, () => {});
  await engine.start();
  await engine.enqueue({
    operation: 'delete', entryId: 'entry_core_client_1', baseRevision: 1,
    clientSequence: 1, idempotencyKey: 'core-client-staged-operation-1',
  });
  assert.equal(published, 0);
  assert.equal(persistence.queued.length, 1);
  await engine.flush(); engine.stop();
  assert.equal(published, 1);
  assert.equal(persistence.queued.length, 0);
});

test('ordered client retains apply intent and cursor when local materialization fails', async () => {
  const persistence = new MemoryPersistence();
  const remoteEvent = {
    sequence: 6, eventId: 'event_core_client_6', actor: { type: 'device' as const, id: 'device_core_remote_1' },
    operation: 'modify' as const, entryId: 'entry_core_client_1', path: 'Note.md', baseRevision: 1,
    revision: 2, hash: sha256Text('remote'), size: 6, occurredAt: '2026-07-13T00:00:00.000Z',
  };
  let acknowledged = false;
  const transport: SyncClientTransport = {
    async handshake() { return { vaultId: 'vault_core_client_1', latestSequence: 6, minimumRetainedSequence: 1, readOnly: false }; },
    async manifest() { return { entries: [], snapshotSequence: 5 }; },
    async operations() { return []; },
    async changes() { return { events: [remoteEvent], nextAfter: 6, hasMore: false, latestSequence: 6 }; },
    async acknowledge() { acknowledged = true; },
    async connectWake() { return () => {}; },
  };
  const adapter: SyncLocalAdapter = {
    async apply() { throw new Error('local vault unavailable'); }, async recover() {}, async bootstrap() {}, async conflict() {},
  };
  const engine = new OrderedSyncClient(persistence, transport, adapter, () => {});
  await assert.rejects(() => engine.start(), /local vault unavailable/); engine.stop();
  assert.equal(persistence.device.cursor, 5);
  assert.equal(persistence.intents[0]?.event.eventId, remoteEvent.eventId);
  assert.equal(acknowledged, false);
});

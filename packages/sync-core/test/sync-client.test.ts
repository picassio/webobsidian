import assert from 'node:assert/strict';
import test from 'node:test';
import { OrderedSyncClient, sha256Text, type ClientApplyIntent, type ClientDeviceIdentity, type OperationResult, type SyncClientPersistence, type SyncClientTransport, type SyncLocalAdapter, type SyncOperation } from '../src/index.js';

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

function operation(sequence: number): SyncOperation {
  return {
    operation: 'delete', entryId: `entry_core_batch_${sequence}`, baseRevision: 1,
    clientSequence: sequence, idempotencyKey: `core-client-batch-operation-${sequence}`,
  };
}

function accepted(operations: SyncOperation[]): OperationResult[] {
  return operations.map((item) => ({
    idempotencyKey: item.idempotencyKey, status: 'accepted', sequence: item.clientSequence + 5,
  }));
}

function batchTransport(
  publish: (operations: SyncOperation[]) => Promise<OperationResult[]>,
  maxOperationsPerBatch = 100,
): SyncClientTransport {
  return {
    async handshake(device) {
      return {
        vaultId: device.vaultId, latestSequence: device.cursor, minimumRetainedSequence: 1, readOnly: false,
        limits: { maxOperationsPerBatch }, capabilities: ['ordered-batch-stop-v1'],
      };
    },
    async manifest() { return { entries: [], snapshotSequence: 0 }; },
    operations: publish,
    async changes(after) { return { events: [], nextAfter: after, hasMore: false, latestSequence: after }; },
    async acknowledge() {}, async connectWake() { return () => {}; },
  };
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

test('wake waits for every local batch before pulling the echoed event', async () => {
  const persistence = new MemoryPersistence();
  let wake: (() => void) | null = null;
  let pulls = 0;
  let queuedAtWakePull = -1;
  const batchSizes: number[] = [];
  const transport: SyncClientTransport = {
    async handshake() {
      return {
        vaultId: 'vault_core_client_1', latestSequence: 5, minimumRetainedSequence: 1, readOnly: false,
        limits: { maxOperationsPerBatch: 100 }, capabilities: ['ordered-batch-stop-v1'],
      };
    },
    async manifest() { return { entries: [], snapshotSequence: 5 }; },
    async operations(operations) {
      batchSizes.push(operations.length);
      wake?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return accepted(operations);
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
  for (let sequence = 1; sequence <= 100; sequence += 1) await engine.enqueue(operation(sequence));
  await engine.queue(operation(101));
  for (let attempt = 0; attempt < 20 && queuedAtWakePull < 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  engine.stop();
  assert.deepEqual(batchSizes, [100, 1]);
  assert.equal(queuedAtWakePull, 0);
});

test('startup lifecycle preserves recovery, bootstrap, local flush, and catch-up ordering', async () => {
  const persistence = new MemoryPersistence();
  persistence.device = { ...persistence.device, cursor: 0 };
  const recoveryEvent = {
    sequence: 6, eventId: 'event_core_recovery_6', actor: { type: 'device' as const, id: 'device_core_remote_1' },
    operation: 'mkdir' as const, entryId: 'entry_core_recovery_1', path: 'Recovered', baseRevision: null,
    revision: 1, hash: null, size: 0, occurredAt: '2026-07-16T00:00:00.000Z',
  };
  const catchUpEvent = {
    sequence: 8, eventId: 'event_core_catch_up_8', actor: { type: 'device' as const, id: 'device_core_remote_1' },
    operation: 'mkdir' as const, entryId: 'entry_core_catch_up_1', path: 'Remote', baseRevision: null,
    revision: 1, hash: null, size: 0, occurredAt: '2026-07-16T00:00:01.000Z',
  };
  persistence.intents = [{ event: recoveryEvent, createdAt: recoveryEvent.occurredAt }];
  const staged = operation(1);
  const order: string[] = [];
  const transport: SyncClientTransport = {
    async handshake() { order.push('handshake'); return { vaultId: persistence.device.vaultId, latestSequence: 8, minimumRetainedSequence: 1, readOnly: false }; },
    async manifest() { order.push('manifest'); return { entries: [], snapshotSequence: 7 }; },
    async operations(operations) { order.push(`flush:${operations.length}`); return accepted(operations); },
    async changes(after) { order.push(`catch-up:${after}`); return { events: [catchUpEvent], nextAfter: 8, hasMore: false, latestSequence: 8 }; },
    async acknowledge() {}, async connectWake() { return () => {}; },
  };
  const adapter: SyncLocalAdapter = {
    async recover() { order.push('recover'); }, async apply() { order.push('apply'); }, async conflict() {},
    async bootstrap() { order.push('bootstrap'); },
  };
  const engine = new OrderedSyncClient(persistence, transport, adapter, () => {}, undefined, undefined, {
    async onRecoveryComplete(event) { order.push(`recovery-complete:${event.sequence}`); },
    async afterRecovery() { order.push('after-recovery'); },
    async beforeBootstrap(snapshot) {
      order.push(`before-bootstrap:${snapshot.snapshotSequence}`);
      assert.equal(persistence.device.cursor, 0);
    },
    async beforeInitialFlush() {
      order.push(`before-flush:${persistence.device.cursor}`);
      await persistence.putOperation(staged);
    },
    async onOperationDurable(item) { order.push(`operation-durable:${item.clientSequence}`); },
    async beforeInitialCatchUp() { order.push('before-catch-up'); },
    async onEventDurable(event) { order.push(`event-durable:${event.sequence}`); },
  });

  await engine.start();
  engine.stop();

  assert.deepEqual(order, [
    'recover', 'recovery-complete:6', 'after-recovery', 'handshake', 'manifest', 'before-bootstrap:7',
    'bootstrap', 'before-flush:7', 'flush:1', 'operation-durable:1', 'before-catch-up',
    'catch-up:7', 'apply', 'event-durable:8',
  ]);
  assert.deepEqual(persistence.queued, []);
  assert.deepEqual(persistence.intents, []);
  assert.equal(persistence.device.cursor, 8);
});

test('startup lifecycle hook failures stop before unsafe later transitions', async () => {
  for (const failingHook of ['beforeBootstrap', 'beforeInitialFlush'] as const) {
    const persistence = new MemoryPersistence();
    persistence.device = { ...persistence.device, cursor: 0 };
    persistence.queued = [operation(1)];
    const order: string[] = [];
    const transport: SyncClientTransport = {
      async handshake() { order.push('handshake'); return { vaultId: persistence.device.vaultId, latestSequence: 1, minimumRetainedSequence: 1, readOnly: false }; },
      async manifest() { order.push('manifest'); return { entries: [], snapshotSequence: 1 }; },
      async operations() { order.push('flush'); return []; },
      async changes(after) { order.push('catch-up'); return { events: [], nextAfter: after, hasMore: false, latestSequence: after }; },
      async acknowledge() {}, async connectWake() { return () => {}; },
    };
    const adapter: SyncLocalAdapter = {
      async apply() {}, async recover() {}, async conflict() {},
      async bootstrap() { order.push('bootstrap'); },
    };
    const statuses: string[] = [];
    const lifecycle = {
      async beforeBootstrap() {
        order.push('before-bootstrap');
        if (failingHook === 'beforeBootstrap') throw new Error('scan checkpoint unavailable');
      },
      async beforeInitialFlush() {
        order.push('before-flush');
        if (failingHook === 'beforeInitialFlush') throw new Error('upload unavailable');
      },
    };
    const engine = new OrderedSyncClient(persistence, transport, adapter, (status) => { statuses.push(status); }, undefined, undefined, lifecycle);

    await assert.rejects(() => engine.start(), failingHook === 'beforeBootstrap' ? /scan checkpoint unavailable/ : /upload unavailable/);
    engine.stop();

    assert.deepEqual(statuses, ['syncing', 'offline']);
    assert.equal(order.includes('flush'), false);
    assert.equal(order.includes('catch-up'), false);
    if (failingHook === 'beforeBootstrap') {
      assert.deepEqual(order, ['handshake', 'manifest', 'before-bootstrap']);
      assert.equal(persistence.device.cursor, 0);
    } else {
      assert.deepEqual(order, ['handshake', 'manifest', 'before-bootstrap', 'bootstrap', 'before-flush']);
      assert.equal(persistence.device.cursor, 1);
    }
    assert.deepEqual(persistence.queued.map((item) => item.clientSequence), [1]);
  }
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

test('flush publishes more than 200 operations in ordered protocol-sized batches', async () => {
  const persistence = new MemoryPersistence();
  persistence.queued = Array.from({ length: 205 }, (_, index) => operation(205 - index));
  const batches: number[][] = [];
  const transport = batchTransport(async (operations) => {
    batches.push(operations.map((item) => item.clientSequence));
    return accepted(operations);
  });
  const adapter = { async apply() {}, async recover() {}, async bootstrap() {}, async conflict() {} } as SyncLocalAdapter;
  const engine = new OrderedSyncClient(persistence, transport, adapter, () => {});

  await engine.start();
  engine.stop();

  assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 5]);
  assert.deepEqual(batches.flat(), Array.from({ length: 205 }, (_, index) => index + 1));
  assert.deepEqual(persistence.queued, []);
});

test('flush honors a smaller server-advertised operation batch limit', async () => {
  const persistence = new MemoryPersistence();
  persistence.queued = Array.from({ length: 5 }, (_, index) => operation(index + 1));
  const batchSizes: number[] = [];
  const transport: SyncClientTransport = {
    async handshake() {
      return {
        vaultId: persistence.device.vaultId, latestSequence: 5, minimumRetainedSequence: 1, readOnly: false,
        limits: { maxOperationsPerBatch: 2 }, capabilities: ['ordered-batch-stop-v1'],
      };
    },
    async manifest() { return { entries: [], snapshotSequence: 5 }; },
    async operations(operations) { batchSizes.push(operations.length); return accepted(operations); },
    async changes(after) { return { events: [], nextAfter: after, hasMore: false, latestSequence: 5 }; },
    async acknowledge() {}, async connectWake() { return () => {}; },
  };
  const adapter: SyncLocalAdapter = { async apply() {}, async recover() {}, async bootstrap() {}, async conflict() {} };
  const engine = new OrderedSyncClient(persistence, transport, adapter, () => {});

  await engine.start();
  engine.stop();

  assert.deepEqual(batchSizes, [2, 2, 1]);
});

test('old servers without ordered batch-stop capability remain on one operation per request', async () => {
  const persistence = new MemoryPersistence();
  persistence.queued = [operation(1), operation(2), operation(3)];
  const batchSizes: number[] = [];
  const transport: SyncClientTransport = {
    async handshake(device) {
      return {
        vaultId: device.vaultId, latestSequence: device.cursor, minimumRetainedSequence: 1, readOnly: false,
        limits: { maxOperationsPerBatch: 100 }, capabilities: ['operations-v1'],
      };
    },
    async manifest() { return { entries: [], snapshotSequence: 0 }; },
    async operations(operations) { batchSizes.push(operations.length); return accepted(operations); },
    async changes(after) { return { events: [], nextAfter: after, hasMore: false, latestSequence: after }; },
    async acknowledge() {}, async connectWake() { return () => {}; },
  };
  const adapter = { async apply() {}, async recover() {}, async bootstrap() {}, async conflict() {} } as SyncLocalAdapter;
  const engine = new OrderedSyncClient(persistence, transport, adapter, () => {});

  await engine.start();
  engine.stop();

  assert.deepEqual(batchSizes, [1, 1, 1]);
});

test('atomic bulk queue removal is used once per accepted batch', async () => {
  const persistence = new MemoryPersistence();
  persistence.queued = Array.from({ length: 205 }, (_, index) => operation(index + 1));
  const removedBatches: number[][] = [];
  persistence.removeOperations = async (keys) => {
    removedBatches.push(keys.map((key) => Number(key.split('-').at(-1))));
    const removed = new Set(keys);
    persistence.queued = persistence.queued.filter((item) => !removed.has(item.idempotencyKey));
  };
  const transport = batchTransport(async (operations) => accepted(operations));
  const adapter = { async apply() {}, async recover() {}, async bootstrap() {}, async conflict() {} } as SyncLocalAdapter;
  const engine = new OrderedSyncClient(persistence, transport, adapter, () => {});

  await engine.start();
  engine.stop();

  assert.deepEqual(removedBatches.map((batch) => batch.length), [100, 100, 5]);
  assert.deepEqual(persistence.queued, []);
});

test('flush durably reconciles a mixed batch but stops before later batches on rejected results', async () => {
  const persistence = new MemoryPersistence();
  persistence.queued = Array.from({ length: 105 }, (_, index) => operation(index + 1));
  const published: number[][] = [];
  const conflicts: string[] = [];
  const committed: string[] = [];
  const transport = batchTransport(async (operations) => {
      published.push(operations.map((item) => item.clientSequence));
      return operations.map((item): OperationResult => {
        const status: OperationResult['status'] = item.clientSequence === 2 ? 'merged'
          : item.clientSequence === 3 ? 'conflict'
            : item.clientSequence === 4 ? 'rejected'
              : item.clientSequence > 4 ? 'dependency_failed' : 'accepted';
        return { idempotencyKey: item.idempotencyKey, status };
      });
  });
  const adapter = {
    async apply() {}, async recover() {}, async bootstrap() {},
    async committed(item: SyncOperation, result: OperationResult) { committed.push(`${item.clientSequence}:${result.status}`); },
    async conflict(result: OperationResult) { conflicts.push(`${result.idempotencyKey}:${result.status}`); },
  } as SyncLocalAdapter;
  const engine = new OrderedSyncClient(persistence, transport, adapter, () => {});

  await engine.start();
  engine.stop();

  assert.equal(published.length, 1);
  assert.deepEqual(committed.slice(0, 2), ['1:accepted', '2:merged']);
  assert.deepEqual(conflicts, [
    'core-client-batch-operation-3:conflict',
    'core-client-batch-operation-4:rejected',
  ]);
  assert.deepEqual(persistence.queued.map((item) => item.clientSequence), Array.from({ length: 102 }, (_, index) => index + 4));
});

test('flush retains a whole batch when result coverage is partial', async () => {
  const persistence = new MemoryPersistence();
  persistence.queued = [operation(1), operation(2), operation(3)];
  let projected = 0;
  const transport = batchTransport(async (operations) => accepted(operations).slice(0, 2));
  const adapter = {
    async apply() {}, async recover() {}, async bootstrap() {},
    async committed() { projected += 1; }, async conflict() { projected += 1; },
  } as SyncLocalAdapter;
  const engine = new OrderedSyncClient(persistence, transport, adapter, () => {});

  await assert.rejects(() => engine.start(), /exactly cover/);
  engine.stop();

  assert.equal(projected, 0);
  assert.deepEqual(persistence.queued.map((item) => item.clientSequence), [1, 2, 3]);
});

test('flush accepts reordered result rows but reconciles them in submitted order', async () => {
  const persistence = new MemoryPersistence();
  persistence.queued = [operation(1), operation(2), operation(3)];
  const committed: number[] = [];
  const transport = batchTransport(async (operations) => accepted(operations).reverse());
  const adapter = {
    async apply() {}, async recover() {}, async bootstrap() {},
    async committed(item: SyncOperation) { committed.push(item.clientSequence); }, async conflict() {},
  } as SyncLocalAdapter;
  const engine = new OrderedSyncClient(persistence, transport, adapter, () => {});

  await engine.start();
  engine.stop();

  assert.deepEqual(committed, [1, 2, 3]);
  assert.deepEqual(persistence.queued, []);
});

test('flush retains the entire batch when the operation response is lost', async () => {
  const persistence = new MemoryPersistence();
  persistence.queued = [operation(1), operation(2), operation(3)];
  const transport = batchTransport(async () => { throw new Error('response lost'); });
  const adapter = { async apply() {}, async recover() {}, async bootstrap() {}, async committed() {}, async conflict() {} } as SyncLocalAdapter;
  const engine = new OrderedSyncClient(persistence, transport, adapter, () => {});

  await assert.rejects(() => engine.start(), /response lost/);
  engine.stop();

  assert.deepEqual(persistence.queued.map((item) => item.clientSequence), [1, 2, 3]);
});

test('flush only removes the durable prefix at every per-result persistence failure boundary', async () => {
  for (let failAt = 1; failAt <= 4; failAt += 1) {
    const persistence = new MemoryPersistence();
    persistence.queued = [operation(1), operation(2), operation(3), operation(4)];
    const removeOperation = persistence.removeOperation.bind(persistence);
    persistence.removeOperation = async (key) => {
      if (key === operation(failAt).idempotencyKey) throw new Error(`durable queue unavailable at ${failAt}`);
      await removeOperation(key);
    };
    const transport = batchTransport(async (operations) => accepted(operations));
    const adapter = { async apply() {}, async recover() {}, async bootstrap() {}, async committed() {}, async conflict() {} } as SyncLocalAdapter;
    const engine = new OrderedSyncClient(persistence, transport, adapter, () => {});

    await assert.rejects(() => engine.start(), new RegExp(`durable queue unavailable at ${failAt}`));
    engine.stop();

    assert.deepEqual(
      persistence.queued.map((item) => item.clientSequence),
      Array.from({ length: 5 - failAt }, (_, index) => failAt + index),
    );
  }
});

test('durable callbacks run after persistence and cannot roll durable transitions back', async () => {
  const persistence = new MemoryPersistence();
  persistence.queued = [operation(1)];
  const transport = {
    async operations(operations: SyncOperation[]) { return accepted(operations); },
  } as SyncClientTransport;
  const adapter = { async committed() {}, async conflict() {} } as SyncLocalAdapter;
  const engine = new OrderedSyncClient(persistence, transport, adapter, () => {}, undefined, undefined, {
    async onOperationDurable() {
      assert.deepEqual(persistence.queued, []);
      throw new Error('progress observer failed');
    },
  });

  await assert.rejects(() => engine.flush(), /progress observer failed/);
  assert.deepEqual(persistence.queued, []);

  const remoteEvent = {
    sequence: 6, eventId: 'event_core_callback_6', actor: { type: 'device' as const, id: 'device_core_remote_1' },
    operation: 'modify' as const, entryId: 'entry_core_client_1', path: 'Note.md', baseRevision: 1,
    revision: 2, hash: sha256Text('remote'), size: 6, occurredAt: '2026-07-16T00:00:00.000Z',
  };
  const eventTransport = {
    async changes() { return { events: [remoteEvent], nextAfter: 6, hasMore: false, latestSequence: 6 }; },
  } as SyncClientTransport;
  const eventAdapter = { async apply() {} } as SyncLocalAdapter;
  const eventEngine = new OrderedSyncClient(persistence, eventTransport, eventAdapter, () => {}, undefined, undefined, {
    async onEventDurable(event) {
      assert.equal(event.eventId, remoteEvent.eventId);
      assert.equal(persistence.device.cursor, 6);
      assert.deepEqual(persistence.intents, []);
      throw new Error('event progress observer failed');
    },
  });

  await assert.rejects(() => eventEngine.catchUp(), /event progress observer failed/);
  assert.equal(persistence.device.cursor, 6);
  assert.deepEqual(persistence.intents, []);
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

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256Text, type OperationResult, type SyncEvent } from '@webobsidian/sync-core';
import { CoordinatorError, SyncCoordinator } from '../src/sync/coordinator.js';
import { TransactionIntentStore } from '../src/sync/intents.js';
import { JournalStore } from '../src/sync/journal.js';

async function setup(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-recovery-vault-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-recovery-data-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]));
  const coordinator = new SyncCoordinator({ vaultRoot: root, dataDir: data });
  await coordinator.initialize();
  const created = await coordinator.apply({
    operation: 'create', clientSequence: 1, idempotencyKey: 'device:recovery:create:1',
    path: 'A.md', kind: 'file', content: { hash: sha256Text('old'), size: 3, inlineText: 'old' },
  }, { type: 'device', id: 'device_recovery_1' });
  return { root, data, created };
}

function recoveryEvent(entryId: string): {
  event: SyncEvent;
  result: OperationResult;
  clientSequence: number;
  operationFingerprint: string;
} {
  const event: SyncEvent = {
    sequence: 2,
    eventId: 'event_recovery_0002',
    actor: { type: 'device', id: 'device_recovery_1' },
    operation: 'modify', entryId, path: 'A.md', baseRevision: 1, revision: 2,
    hash: sha256Text('new'), previousHash: sha256Text('old'), size: 3,
    occurredAt: '2026-07-12T00:00:02.000Z',
  };
  return {
    event,
    clientSequence: 2,
    operationFingerprint: sha256Text('recovery-modify-op'),
    result: {
      idempotencyKey: 'device:recovery:modify:2', status: 'accepted', eventId: event.eventId,
      sequence: 2, entryId, revision: 2, hash: event.hash, path: event.path,
    },
  };
}

test('startup finishes a materialized pre-commit intent as the exact planned event', async (t) => {
  const { root, data, created } = await setup(t);
  const source = path.join(data, 'new-source');
  await fs.writeFile(source, 'new');
  const old = path.join(root, 'A.md');
  const stores = new TransactionIntentStore(data);
  const planned = recoveryEvent(created.entryId!);
  const intent = await stores.prepare({ ...planned, targetPath: 'A.md', previousPath: 'A.md', newContentSource: source, previousContentSource: old });
  await fs.writeFile(old, 'new'); // simulated crash after materialization
  await stores.markMaterialized(intent.transactionId);

  const recovered = new SyncCoordinator({ vaultRoot: root, dataDir: data });
  await recovered.initialize();
  assert.equal(recovered.health().readOnly, false);
  assert.equal(await fs.readFile(old, 'utf8'), 'new');
  assert.equal(await new JournalStore(data).latestSequence(), 2);
  assert.equal((await new JournalStore(data).replay()).at(-1)?.eventId, planned.event.eventId);
  assert.deepEqual(await stores.list(), []);
});

test('startup rolls back an unmaterialized intent without committing an event', async (t) => {
  const { root, data, created } = await setup(t);
  const source = path.join(data, 'new-source');
  await fs.writeFile(source, 'new');
  const old = path.join(root, 'A.md');
  const stores = new TransactionIntentStore(data);
  const planned = recoveryEvent(created.entryId!);
  await stores.prepare({ ...planned, targetPath: 'A.md', previousPath: 'A.md', newContentSource: source, previousContentSource: old });

  const recovered = new SyncCoordinator({ vaultRoot: root, dataDir: data });
  await recovered.initialize();
  assert.equal(recovered.health().readOnly, false);
  assert.equal(await fs.readFile(old, 'utf8'), 'old');
  assert.equal(await new JournalStore(data).latestSequence(), 1);
  assert.deepEqual(await stores.list(), []);
});

test('journal corruption enters read-only degraded mode and rejects writes', async (t) => {
  const { root, data } = await setup(t);
  const segment = path.join(data, 'sync', 'journal', '00000001.json');
  const body = JSON.parse(await fs.readFile(segment, 'utf8')) as { payload: { lastSequence: number } };
  body.payload.lastSequence = 99;
  await fs.writeFile(segment, JSON.stringify(body));
  const recovered = new SyncCoordinator({ vaultRoot: root, dataDir: data });
  await recovered.initialize();
  assert.equal(recovered.health().readOnly, true);
  await assert.rejects(() => recovered.apply({
    operation: 'mkdir', clientSequence: 2, idempotencyKey: 'device:degraded:mkdir:2', path: 'Blocked', kind: 'directory',
  }, { type: 'device', id: 'device_recovery_1' }), (error: unknown) => error instanceof CoordinatorError && error.code === 'sync_read_only');
});

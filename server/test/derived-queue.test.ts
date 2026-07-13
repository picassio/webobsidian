import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256Text, type SyncEvent } from '@picassio/sync-core';
import { DerivedEventQueue } from '../src/sync/derived-queue.js';
import { SyncCoordinator } from '../src/sync/coordinator.js';

async function directory(t: TestContext) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-derived-'));
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}

function event(): SyncEvent {
  return {
    sequence: 1, eventId: 'event_derived_queue_1', actor: { type: 'server-fs', id: 'server_derived_queue' },
    operation: 'create', entryId: 'entry_derived_queue_1', path: 'A.md', baseRevision: null, revision: 1,
    hash: sha256Text('a'), size: 1, occurredAt: '2026-07-13T00:00:00.000Z',
  };
}

test('derived queue durably retries without advancing applied sequence on failure', async (t) => {
  const data = await directory(t);
  const queue = new DerivedEventQueue(data);
  await queue.initializeAt(0);
  await queue.enqueue(event());
  await assert.rejects(() => queue.process(async () => { throw new Error('index unavailable'); }));
  assert.deepEqual(queue.status(), { appliedSequence: 0, pending: 1, failedAttempts: 1, lastError: 'index unavailable' });
  await queue.process(async () => {});
  assert.deepEqual(queue.status(), { appliedSequence: 1, pending: 0, failedAttempts: 0, lastError: null });
  const reopened = new DerivedEventQueue(data);
  await reopened.initializeAt(99);
  assert.equal(reopened.status().appliedSequence, 1);
});

test('coordinator health exposes derived index lag until subscriber succeeds', async (t) => {
  const root = await directory(t);
  const data = await directory(t);
  const coordinator = new SyncCoordinator({ vaultRoot: root, dataDir: data });
  await coordinator.initialize();
  await coordinator.apply({
    operation: 'create', clientSequence: 1, idempotencyKey: 'device:derived:create:1', path: 'A.md', kind: 'file',
    content: { hash: sha256Text('a'), size: 1, inlineText: 'a' },
  }, { type: 'device', id: 'device_derived_queue_1' });
  assert.equal(coordinator.health().indexLagSequence, 1);
  let applied = false;
  coordinator.subscribe(async () => { applied = true; });
  for (let attempt = 0; attempt < 50 && !applied; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(applied, true);
  for (let attempt = 0; attempt < 50 && coordinator.health().indexLagSequence; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(coordinator.health().indexLagSequence, 0);
});

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256Text } from '@picassio/sync-core';
import { SyncCoordinator } from '../src/sync/coordinator.js';
import { JournalStore } from '../src/sync/journal.js';
import { MergeBaseStore } from '../src/sync/base-store.js';

async function setup(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-external-vault-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-external-data-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]));
  const coordinator = new SyncCoordinator({ vaultRoot: root, dataDir: data });
  await coordinator.initialize();
  return { root, data, coordinator };
}

test('external add/modify/delete becomes one revisioned event each with recoverable trash', async (t) => {
  const { root, data, coordinator } = await setup(t);
  const file = path.join(root, 'External.md');
  await fs.writeFile(file, 'one');
  const created = await coordinator.reconcileExternalPath('External.md', 'add');
  assert.equal(created?.revision, 1);

  await fs.writeFile(file, 'two');
  const modified = await coordinator.reconcileExternalPath('External.md', 'change');
  assert.equal(modified?.revision, 2);
  assert.ok(await new MergeBaseStore(data).get(created!.entryId!, 1));

  // Duplicate watcher echo is suppressed by (path, hash).
  assert.equal(await coordinator.reconcileExternalPath('External.md', 'change'), null);
  await fs.unlink(file);
  const deleted = await coordinator.reconcileExternalPath('External.md', 'unlink');
  assert.equal(deleted?.revision, 3);
  const trash = (await coordinator.listTrash())[0]!;
  assert.equal(await fs.readFile(path.join(root, trash.trashPath), 'utf8'), 'two');
  assert.deepEqual((await new JournalStore(data).replay()).map((event) => event.operation), ['create', 'modify', 'delete']);
});

test('coordinator-originated watcher echo does not create a duplicate event', async (t) => {
  const { root, data, coordinator } = await setup(t);
  await coordinator.apply({
    operation: 'create', clientSequence: 1, idempotencyKey: 'device:external:echo:1',
    path: 'Echo.md', kind: 'file',
    content: { hash: sha256Text('same'), size: 4, inlineText: 'same' },
  }, { type: 'device', id: 'device_external_echo_1' });
  assert.equal(await fs.readFile(path.join(root, 'Echo.md'), 'utf8'), 'same');
  assert.equal(await coordinator.reconcileExternalPath('Echo.md', 'add'), null);
  assert.equal(await new JournalStore(data).latestSequence(), 1);
});

test('periodic/startup drift scan correlates hash-stable rename and catches offline modification', async (t) => {
  const { root, data, coordinator } = await setup(t);
  const created = await coordinator.apply({
    operation: 'create', clientSequence: 1, idempotencyKey: 'device:external:drift:1',
    path: 'Before.md', kind: 'file',
    content: { hash: sha256Text('content'), size: 7, inlineText: 'content' },
  }, { type: 'device', id: 'device_external_drift_1' });
  await fs.rename(path.join(root, 'Before.md'), path.join(root, 'After.md'));
  assert.equal(await coordinator.reconcileExternalDrift(), 1);
  assert.equal((await coordinator.entryByPath('After.md'))?.entryId, created.entryId);

  await fs.writeFile(path.join(root, 'After.md'), 'offline-change');
  const restarted = new SyncCoordinator({ vaultRoot: root, dataDir: data });
  await restarted.initialize();
  assert.equal(restarted.health().readOnly, false);
  assert.equal((await restarted.entryByPath('After.md'))?.revision, 3);
  assert.equal(await new JournalStore(data).latestSequence(), 3);
});

test('external empty directory lifecycle is revisioned', async (t) => {
  const { root, data, coordinator } = await setup(t);
  await fs.mkdir(path.join(root, 'Empty'));
  const created = await coordinator.reconcileExternalPath('Empty', 'addDir');
  await fs.rmdir(path.join(root, 'Empty'));
  const deleted = await coordinator.reconcileExternalPath('Empty', 'unlinkDir');
  assert.equal(created?.entryId, deleted?.entryId);
  assert.deepEqual((await new JournalStore(data).replay()).map((event) => event.operation), ['mkdir', 'rmdir']);
});

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256Text } from '@picassio/sync-core';
import { SyncCoordinator } from '../src/sync/coordinator.js';
import { SyncDoctor } from '../src/sync/doctor.js';
import { JournalStore } from '../src/sync/journal.js';

const actor = { type: 'device' as const, id: 'device_restore_drill_1' };

test('crash-consistent vault plus data/sync backup restores exact authoritative history', async (t) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-restore-drill-'));
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  const root = path.join(work, 'live-vault'); const data = path.join(work, 'live-data');
  await fs.mkdir(root); await fs.mkdir(data);
  const coordinator = new SyncCoordinator({ vaultRoot: root, dataDir: data }); await coordinator.initialize();
  const created = await coordinator.apply({
    operation: 'create', path: 'Restore.md', kind: 'file', clientSequence: 1,
    idempotencyKey: 'restore-drill:create:0001', content: { hash: sha256Text('one'), size: 3, inlineText: 'one' },
  }, actor);
  await coordinator.apply({
    operation: 'modify', entryId: created.entryId!, baseRevision: 1, clientSequence: 2,
    idempotencyKey: 'restore-drill:modify:0002', content: { hash: sha256Text('two'), size: 3, inlineText: 'two' },
  }, actor);
  await coordinator.flushProjection();

  const backupRoot = path.join(work, 'backup-vault'); const backupData = path.join(work, 'backup-data');
  await fs.cp(root, backupRoot, { recursive: true }); await fs.cp(data, backupData, { recursive: true });
  await coordinator.apply({
    operation: 'modify', entryId: created.entryId!, baseRevision: 2, clientSequence: 3,
    idempotencyKey: 'restore-drill:later:0003', content: { hash: sha256Text('later'), size: 5, inlineText: 'later' },
  }, actor);

  const restoredRoot = path.join(work, 'restored-vault'); const restoredData = path.join(work, 'restored-data');
  await fs.cp(backupRoot, restoredRoot, { recursive: true }); await fs.cp(backupData, restoredData, { recursive: true });
  const restored = new SyncCoordinator({ vaultRoot: restoredRoot, dataDir: restoredData }); await restored.initialize();
  assert.equal(restored.health().readOnly, false);
  assert.equal(restored.health().latestSequence, 2);
  assert.equal(await fs.readFile(path.join(restoredRoot, 'Restore.md'), 'utf8'), 'two');
  assert.equal(await new JournalStore(restoredData).latestSequence(), 2);
  assert.equal((await restored.entryById(created.entryId!))?.revision, 2);
  assert.equal((await new SyncDoctor(restoredData, restoredRoot).run()).healthy, true);
});

test('vault-only disaster recovery rebuilds healthy sequence-zero metadata without changing bytes', async (t) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-vault-rebuild-'));
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  const root = path.join(work, 'vault'); const data = path.join(work, 'new-data');
  await fs.mkdir(path.join(root, 'Nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'Nested', 'Recovered.md'), '# preserved\n');
  const before = await fs.readFile(path.join(root, 'Nested', 'Recovered.md'));
  const rebuilt = new SyncCoordinator({ vaultRoot: root, dataDir: data }); await rebuilt.initialize();
  assert.equal(rebuilt.health().readOnly, false);
  assert.equal(rebuilt.health().latestSequence, 0);
  assert.deepEqual(await fs.readFile(path.join(root, 'Nested', 'Recovered.md')), before);
  const entry = await rebuilt.entryByPath('Nested/Recovered.md');
  assert.equal(entry?.revision, 1); assert.equal(entry?.hash, sha256Text('# preserved\n'));
  assert.equal((await new SyncDoctor(data, root).run()).healthy, true);
});

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256Text } from '@picassio/sync-core';
import { SyncCoordinator } from '../src/sync/coordinator.js';
import { JournalStore } from '../src/sync/journal.js';

const writerA = { type: 'device' as const, id: 'device_e2e_writer_a' };
const writerB = { type: 'device' as const, id: 'device_e2e_writer_b' };

test('two writers plus direct filesystem edits produce one gapless authoritative history', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-e2e-vault-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-e2e-data-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]));
  const coordinator = new SyncCoordinator({ vaultRoot: root, dataDir: data });
  await coordinator.initialize();

  const created = await coordinator.apply({
    operation: 'create', clientSequence: 1, idempotencyKey: 'writer-a:create:0001', path: 'Shared.md', kind: 'file',
    content: { hash: sha256Text('base\n'), size: 5, inlineText: 'base\n' },
  }, writerA);
  const serverEdit = await coordinator.apply({
    operation: 'modify', clientSequence: 2, idempotencyKey: 'writer-a:modify:0002',
    entryId: created.entryId!, baseRevision: 1,
    content: { hash: sha256Text('writer-a\n'), size: 9, inlineText: 'writer-a\n' },
  }, writerA);
  const conflict = await coordinator.apply({
    operation: 'modify', clientSequence: 1, idempotencyKey: 'writer-b:modify:0001',
    entryId: created.entryId!, baseRevision: 1,
    content: { hash: sha256Text('writer-b\n'), size: 9, inlineText: 'writer-b\n' },
  }, writerB);
  assert.equal(conflict.status, 'conflict');
  assert.equal(await fs.readFile(path.join(root, 'Shared.md'), 'utf8'), 'writer-a\n');

  await fs.writeFile(path.join(root, 'Shared.md'), 'direct\n');
  const external = await coordinator.reconcileExternalPath('Shared.md', 'change');
  assert.equal(external?.revision, serverEdit.revision! + 1);

  await Promise.all([
    coordinator.apply({
      operation: 'create', clientSequence: 3, idempotencyKey: 'writer-a:create:0003', path: 'A.md', kind: 'file',
      content: { hash: sha256Text('a'), size: 1, inlineText: 'a' },
    }, writerA),
    coordinator.apply({
      operation: 'create', clientSequence: 2, idempotencyKey: 'writer-b:create:0002', path: 'B.md', kind: 'file',
      content: { hash: sha256Text('b'), size: 1, inlineText: 'b' },
    }, writerB),
  ]);

  const events = await new JournalStore(data).replay();
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1));
  assert.deepEqual(events.map((event) => event.operation), ['create', 'modify', 'create', 'modify', 'create', 'create']);
  assert.equal(events.filter((event) => event.entryId === created.entryId).length, 3);
  assert.equal(events.at(-1)?.sequence, 6);
});

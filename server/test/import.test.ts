import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256Text } from '@webobsidian/sync-core';
import { SyncCoordinator } from '../src/sync/coordinator.js';

const actor = { type: 'git-import' as const, id: 'git_import_test_1' };

test('explicit directory import dry-run and apply emit normal coordinator events', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-import-vault-'));
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-import-source-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-import-data-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(source, { recursive: true, force: true }),
    fs.rm(data, { recursive: true, force: true }),
  ]));
  const coordinator = new SyncCoordinator({ vaultRoot: root, dataDir: data });
  await coordinator.initialize();
  await coordinator.apply({
    operation: 'create', clientSequence: 1, idempotencyKey: 'git-import:initial:a:1', path: 'A.md', kind: 'file',
    content: { hash: sha256Text('old'), size: 3, inlineText: 'old' },
  }, actor);
  await coordinator.apply({
    operation: 'create', clientSequence: 2, idempotencyKey: 'git-import:initial:x:2', path: 'Remove.md', kind: 'file',
    content: { hash: sha256Text('remove'), size: 6, inlineText: 'remove' },
  }, actor);

  await fs.mkdir(path.join(source, 'Empty'));
  await fs.writeFile(path.join(source, 'A.md'), 'new');
  await fs.writeFile(path.join(source, 'B.md'), 'added');
  const plan = await coordinator.planDirectoryImport(source, true);
  assert.deepEqual(plan.createDirectories, ['Empty']);
  assert.deepEqual(plan.createFiles, ['B.md']);
  assert.deepEqual(plan.modifyFiles, ['A.md']);
  assert.deepEqual(plan.deletePaths, ['Remove.md']);

  let sequence = 2;
  const result = await coordinator.importDirectory(source, true, actor, () => {
    sequence += 1;
    return { clientSequence: sequence, idempotencyKey: `git-import:apply:${sequence}` };
  });
  assert.equal(result.results.length, 4);
  assert.equal(await fs.readFile(path.join(root, 'A.md'), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(root, 'B.md'), 'utf8'), 'added');
  assert.equal((await fs.stat(path.join(root, 'Empty'))).isDirectory(), true);
  assert.equal(await fs.stat(path.join(root, 'Remove.md')).catch(() => null), null);
});

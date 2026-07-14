import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('vault registry rejects unsafe roots and unregisters without deleting files or metadata', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-vault-registry-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const defaultRoot = path.join(base, 'default');
  const secondRoot = path.join(base, 'second');
  await Promise.all([fs.mkdir(defaultRoot), fs.mkdir(secondRoot)]);
  await fs.writeFile(path.join(defaultRoot, 'keep-default.md'), '# Default');
  await fs.writeFile(path.join(secondRoot, 'keep.md'), '# Keep');
  process.env.DATA_DIR = path.join(base, 'data');
  process.env.VAULT_PATH = defaultRoot;
  process.env.ALLOWED_ROOTS = base;

  const settingsModule = await import('../src/services/settings.js');
  const registry = await import('../src/services/vault-registry.js');
  const { runInVault } = await import('../src/services/vault-context.js');
  await settingsModule.loadSettings();
  const initial = await settingsModule.getPersistedSettings();
  const original = initial.vaults.items[0];
  assert.equal(original.storage, 'legacy');
  assert.equal(original.name, 'Default');

  const managed = await registry.createManagedVault('Managed Personal Notes');
  assert.equal(managed.storage, 'isolated');
  assert.equal(managed.sync.enabled, true);
  assert.equal(managed.sync.bootstrapState, 'ready');
  assert.equal(path.dirname(managed.path), base);
  assert.match(path.basename(managed.path), /^managed-personal-notes-[a-f0-9]{10}$/);
  assert.equal((await fs.stat(managed.path)).mode & 0o777, 0o750);
  assert.deepEqual(await fs.readdir(managed.path), []);

  const second = await registry.registerVault({ name: 'Second', path: secondRoot });
  assert.equal(second.storage, 'isolated');
  assert.equal(second.sync.bootstrapState, 'backup-required');
  assert.equal(second.sync.enabled, false);
  const secondData = registry.vaultDataDir(second.id, second.storage);
  assert.equal((await fs.stat(path.join(secondData, 'sync', 'vault.json'))).isFile(), true);
  await Promise.all([
    runInVault(await registry.vaultContext(original.id), () => settingsModule.updateSettings((draft) => { draft.plugins.enabled = ['original-plugin']; })),
    runInVault(await registry.vaultContext(second.id), () => settingsModule.updateSettings((draft) => { draft.plugins.enabled = ['second-plugin']; })),
  ]);
  const afterScopedUpdates = await settingsModule.getPersistedSettings();
  assert.deepEqual(afterScopedUpdates.vaults.items.find((item) => item.id === original.id)?.plugins.enabled, ['original-plugin']);
  assert.deepEqual(afterScopedUpdates.vaults.items.find((item) => item.id === second.id)?.plugins.enabled, ['second-plugin']);

  const concurrentRoots = [path.join(base, 'concurrent-a'), path.join(base, 'concurrent-b')];
  await Promise.all(concurrentRoots.map((root) => fs.mkdir(root)));
  const concurrent = await Promise.all(concurrentRoots.map((root, index) => registry.registerVault({ name: `Concurrent ${index}`, path: root })));
  const afterConcurrent = await settingsModule.getPersistedSettings();
  assert.equal(concurrent.every((record) => afterConcurrent.vaults.items.some((item) => item.id === record.id)), true);
  const contestedRoot = path.join(base, 'contested');
  await fs.mkdir(contestedRoot);
  const contested = await Promise.allSettled([
    registry.registerVault({ name: 'Contested A', path: contestedRoot }),
    registry.registerVault({ name: 'Contested B', path: contestedRoot }),
  ]);
  assert.deepEqual(contested.map((result) => result.status).sort(), ['fulfilled', 'rejected']);

  await assert.rejects(
    () => registry.registerVault({ name: 'Nested', path: path.join(secondRoot, 'nested') }),
    /existing non-symlink directory|overlap/,
  );
  const nested = path.join(secondRoot, 'nested');
  await fs.mkdir(nested);
  await assert.rejects(() => registry.registerVault({ name: 'Nested', path: nested }), /overlap/);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-vault-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const allowedEscape = path.join(base, 'allowed-escape');
  await fs.symlink(outside, allowedEscape, 'dir');
  await assert.rejects(
    () => registry.registerVault({ name: 'Allowlist escape', path: outside, allowedRoots: [allowedEscape] }),
    /cannot exceed the server allowlist/,
  );
  const link = path.join(base, 'linked');
  await fs.symlink(secondRoot, link, 'dir');
  await assert.rejects(() => registry.registerVault({ name: 'Linked', path: link }), /non-symlink/);

  await registry.setDefaultVault(second.id);
  const removed = await registry.unregisterVault(original.id);
  assert.equal(removed.id, original.id);
  assert.equal(await fs.readFile(path.join(defaultRoot, 'keep-default.md'), 'utf8'), '# Default');
  assert.equal(await fs.readFile(path.join(secondRoot, 'keep.md'), 'utf8'), '# Keep');
  assert.equal((await fs.stat(path.join(secondData, 'sync', 'vault.json'))).isFile(), true);
  await assert.rejects(() => registry.unregisterVault(second.id), /default vault/);
  const restored = await registry.registerVault({ name: 'Default restored', path: defaultRoot });
  assert.equal(restored.id, original.id);
  assert.equal(restored.storage, 'legacy');
  assert.equal(await fs.readFile(path.join(defaultRoot, 'keep-default.md'), 'utf8'), '# Default');
});

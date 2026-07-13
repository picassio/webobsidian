import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';
import { AtomicJsonStore, CorruptSyncMetadataError, ensureSyncStorage } from '../src/sync/storage.js';
import { VaultStateStore } from '../src/sync/vault-state.js';

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('sync layout and vault identity are created once with restrictive modes', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const paths = await ensureSyncStorage(dataDir);
  for (const directory of Object.values(paths)) assert.equal((await fs.stat(directory)).isDirectory(), true);

  const firstStore = new VaultStateStore(dataDir);
  const first = await firstStore.loadOrCreate();
  const second = await new VaultStateStore(dataDir).loadOrCreate();
  assert.equal(second.vaultId, first.vaultId);
  assert.equal(first.currentSequence, 0);
  assert.equal((await fs.stat(path.join(paths.root, 'vault.json'))).mode & 0o777, 0o600);
});

test('atomic JSON store verifies checksum and retains previous backup', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const file = path.join(dataDir, 'state.json');
  const schema = z.object({ value: z.number().int() }).strict();
  const store = new AtomicJsonStore(file, schema);
  await store.write({ value: 1 });
  await store.write({ value: 2 });
  assert.deepEqual(await store.read(), { value: 2 });
  const backup = JSON.parse(await fs.readFile(`${file}.bak`, 'utf8')) as { payload: { value: number } };
  assert.equal(backup.payload.value, 1);

  const corrupted = JSON.parse(await fs.readFile(file, 'utf8')) as { payload: { value: number } };
  corrupted.payload.value = 99;
  await fs.writeFile(file, JSON.stringify(corrupted));
  await assert.rejects(() => store.read(), CorruptSyncMetadataError);
});

test('vault sequence persists monotonically', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const store = new VaultStateStore(dataDir);
  await store.loadOrCreate();
  await store.setCurrentSequence(4);
  assert.equal((await new VaultStateStore(dataDir).loadOrCreate()).currentSequence, 4);
  await assert.rejects(() => store.setCurrentSequence(3), /backwards/);
});

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HeadlessStore } from '../src/state.js';
import { acquireInstanceLock } from '../src/watcher.js';

test('single-instance lock rejects a live daemon and recovers a stale PID', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-vault-lock-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new HeadlessStore(path.join(root, 'config'));
  await store.initialize({ serverUrl: 'http://localhost:3000', vaultPath: path.join(root, 'vault') });
  const release = await acquireInstanceLock(store);
  await assert.rejects(() => acquireInstanceLock(store), /another daemon/);
  await release();
  await fs.writeFile(store.lockFile, '99999999\n', { mode: 0o600 });
  const releaseRecovered = await acquireInstanceLock(store);
  assert.equal(Number((await fs.readFile(store.lockFile, 'utf8')).trim()), process.pid);
  await releaseRecovered();
});

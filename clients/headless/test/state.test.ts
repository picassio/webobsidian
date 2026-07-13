import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HeadlessStore } from '../src/state.js';

test('headless state is checksummed, atomic, mode 0600, outside vault, and token is separate', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-vault-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config'); const vault = path.join(root, 'vault');
  const store = new HeadlessStore(config);
  await store.initialize({ serverUrl: 'http://127.0.0.1:3000', vaultPath: vault, deviceName: 'test' });
  await store.setToken('headless-secret-token');
  const stateStat = await fs.stat(store.stateFile); const tokenStat = await fs.stat(store.tokenFile);
  assert.equal(stateStat.mode & 0o777, 0o600); assert.equal(tokenStat.mode & 0o777, 0o600);
  assert.equal((await fs.readFile(store.stateFile, 'utf8')).includes('headless-secret-token'), false);
  assert.equal(await store.takeClientSequence(), 1); await store.putCursor(8);
  const reloaded = new HeadlessStore(config); await reloaded.load();
  assert.equal(reloaded.state.cursor, 8); assert.equal(reloaded.state.nextClientSequence, 2);
  const envelope = JSON.parse(await fs.readFile(store.stateFile, 'utf8')); envelope.payload.cursor = 9;
  await fs.writeFile(store.stateFile, JSON.stringify(envelope));
  await assert.rejects(() => new HeadlessStore(config).load(), /checksum/);
});

test('token permission widening fails closed and config inside vault is rejected', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-vault-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new HeadlessStore(path.join(root, 'config'));
  await store.initialize({ serverUrl: 'http://localhost:3000', vaultPath: path.join(root, 'vault') });
  await store.setToken('secret'); await fs.chmod(store.tokenFile, 0o644);
  await assert.rejects(() => store.token(), /0600/);
  const unsafe = new HeadlessStore(path.join(root, 'unsafe-vault', '.state'));
  await assert.rejects(() => unsafe.initialize({ serverUrl: 'http://localhost:3000', vaultPath: path.join(root, 'unsafe-vault') }), /outside the vault/);
});

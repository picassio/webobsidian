import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256Text } from '@picassio/sync-core';
import { FilesystemMutationQueue } from '../src/local-queue.js';
import { HeadlessStore } from '../src/state.js';

async function setup(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-vault-queue-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const store = new HeadlessStore(path.join(root, 'config'));
  await store.initialize({ serverUrl: 'http://localhost:3000', vaultPath: vault });
  await fs.writeFile(path.join(vault, 'note.md'), 'content');
  return { store };
}

test('overlapping flush requests serialize one upload and one operation', async (t) => {
  const { store } = await setup(t);
  let uploads = 0;
  let active = 0;
  let maxActive = 0;
  const adapter = {
    hash: async () => ({ hash: sha256Text('content'), size: 7 }),
    consumeExpected: async () => false,
  };
  const transport = {
    uploadFile: async () => {
      uploads += 1; active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    },
  };
  const operations: unknown[] = [];
  const engine = { queue: async (operation: unknown) => { operations.push(operation); } };
  const queue = new FilesystemMutationQueue(store, adapter as never, transport as never, engine as never);
  await queue.observe({ path: 'note.md', action: 'upsert', observedAt: '2026-07-13T00:00:00.000Z' });
  await Promise.all([queue.flushAll(), queue.flushAll()]);
  assert.equal(uploads, 1);
  assert.equal(maxActive, 1);
  assert.equal(operations.length, 1);
  assert.equal(store.state.pendingPaths.length, 0);
});

test('completed flush does not remove a newer marker for the same path', async (t) => {
  const { store } = await setup(t);
  let releaseHash!: () => void;
  const waiting = new Promise<void>((resolve) => { releaseHash = resolve; });
  let hashing!: () => void;
  const started = new Promise<void>((resolve) => { hashing = resolve; });
  const adapter = {
    hash: async () => { hashing(); await waiting; return { hash: sha256Text('content'), size: 7 }; },
    consumeExpected: async () => false,
  };
  const queue = new FilesystemMutationQueue(
    store,
    adapter as never,
    { uploadFile: async () => {} } as never,
    { queue: async () => {} } as never,
  );
  await queue.observe({ path: 'note.md', action: 'upsert', observedAt: '2026-07-13T00:00:00.000Z' });
  const flushing = queue.flushAll();
  await started;
  await queue.observe({ path: 'note.md', action: 'upsert', observedAt: '2026-07-13T00:00:01.000Z' });
  releaseHash();
  await flushing;
  assert.deepEqual(store.state.pendingPaths, [{ path: 'note.md', action: 'upsert', observedAt: '2026-07-13T00:00:01.000Z' }]);
});

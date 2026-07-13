import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256Text, type SyncEntry } from '@webobsidian/sync-core';
import { FilesystemAdapter } from '../src/fs-adapter.js';
import { HeadlessStore } from '../src/state.js';

async function fixture(t: test.TestContext, mode: 'bidirectional' | 'pull-only' | 'push-only' = 'bidirectional') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-vault-adapter-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new HeadlessStore(path.join(root, 'config')); await store.initialize({ serverUrl: 'http://localhost:3000', vaultPath: path.join(root, 'vault'), mode });
  return { root, store, vault: store.state.vaultPath };
}
function entry(content: string, revision = 1): SyncEntry {
  return { entryId: 'entry_headless_adapter_1', path: 'Notes/A.md', kind: 'file', revision, hash: sha256Text(content), size: Buffer.byteLength(content), modifiedAt: '2026-07-13T00:00:00.000Z', deleted: false, sequence: revision };
}

test('filesystem adapter streams verified remote bytes and quarantines unsubmitted local drift', async (t) => {
  const { store, vault } = await fixture(t); let remote = 'server one\n'; const conflicts: string[] = [];
  const transport = { async download() { return new Response(remote); } };
  const adapter = new FilesystemAdapter(store, transport as never, (result) => conflicts.push(String(result)));
  await adapter.initialize(); await adapter.bootstrap([entry(remote)]);
  assert.equal(await fs.readFile(path.join(vault, 'Notes/A.md'), 'utf8'), remote);
  await fs.writeFile(path.join(vault, 'Notes/A.md'), 'unsent local\n');
  remote = 'server two\n';
  await adapter.apply({ sequence: 2, eventId: 'event_headless_adapter_2', actor: { type: 'device', id: 'device_remote_headless' }, operation: 'modify', entryId: 'entry_headless_adapter_1', path: 'Notes/A.md', baseRevision: 1, revision: 2, hash: sha256Text(remote), previousHash: sha256Text('server one\n'), size: Buffer.byteLength(remote), occurredAt: '2026-07-13T00:00:01.000Z' });
  assert.equal(await fs.readFile(path.join(vault, 'Notes/A.md'), 'utf8'), remote);
  const quarantine = path.join(vault, '.web-vault-sync-quarantine');
  const files = await findFiles(quarantine);
  assert.equal(files.length, 1); assert.equal(await fs.readFile(files[0]!, 'utf8'), 'unsent local\n');
  assert.match(conflicts[0] ?? '', /quarantined/);
});

test('clean server merge replaces the submitted local source without false quarantine', async (t) => {
  const { store, vault } = await fixture(t); let remote = 'one base\nseparator\nthree base\n'; const conflicts: string[] = [];
  const adapter = new FilesystemAdapter(store, { async download() { return new Response(remote); } } as never, (result) => conflicts.push(String(result)));
  await adapter.initialize(); await adapter.bootstrap([entry(remote)]);
  const submitted = 'one base\nseparator\nthree local\n';
  await fs.writeFile(path.join(vault, 'Notes/A.md'), submitted);
  remote = 'one remote\nseparator\nthree local\n';
  await adapter.committed({
    operation: 'modify', entryId: 'entry_headless_adapter_1', baseRevision: 1,
    clientSequence: 1, idempotencyKey: 'headless-merge-operation-1',
    content: { hash: sha256Text(submitted), size: Buffer.byteLength(submitted), inlineText: submitted },
  }, {
    idempotencyKey: 'headless-merge-operation-1', status: 'merged', eventId: 'event_headless_adapter_2',
    sequence: 2, entryId: 'entry_headless_adapter_1', revision: 2, hash: sha256Text(remote), path: 'Notes/A.md',
  });
  assert.equal(store.mergedSource('Notes/A.md'), sha256Text(submitted));
  const restartedStore = new HeadlessStore(store.configDir); await restartedStore.load();
  const restartedAdapter = new FilesystemAdapter(restartedStore, { async download() { return new Response(remote); } } as never, (result) => conflicts.push(String(result)));
  await restartedAdapter.initialize();
  await restartedAdapter.apply({ sequence: 2, eventId: 'event_headless_adapter_2', actor: { type: 'device', id: 'device_local_headless' }, operation: 'modify', entryId: 'entry_headless_adapter_1', path: 'Notes/A.md', baseRevision: 1, revision: 2, hash: sha256Text(remote), previousHash: sha256Text('one base\nseparator\nthree base\n'), size: Buffer.byteLength(remote), occurredAt: '2026-07-13T00:00:01.000Z' });
  assert.equal(restartedStore.mergedSource('Notes/A.md'), undefined);
  assert.equal(await fs.readFile(path.join(vault, 'Notes/A.md'), 'utf8'), remote);
  await assert.rejects(() => fs.access(path.join(vault, '.web-vault-sync-quarantine')));
  assert.deepEqual(conflicts, []);
});

test('hash mismatch and symlink paths fail before canonical write', async (t) => {
  const { store, vault } = await fixture(t);
  const adapter = new FilesystemAdapter(store, { async download() { return new Response('tampered'); } } as never, () => {});
  await adapter.initialize();
  await assert.rejects(() => adapter.bootstrap([entry('expected')]), /verification failed/);
  await assert.rejects(() => fs.access(path.join(vault, 'Notes/A.md')));
  await fs.symlink('/tmp', path.join(vault, 'link'));
  await assert.rejects(() => adapter.scan(), /symlink/);
});

test('pull-only mode quarantines drift and restores projected canonical bytes', async (t) => {
  const { store, vault } = await fixture(t, 'pull-only'); const remote = 'canonical\n';
  const adapter = new FilesystemAdapter(store, { async download() { return new Response(remote); } } as never, () => {});
  await adapter.initialize(); await adapter.bootstrap([entry(remote)]);
  await fs.writeFile(path.join(vault, 'Notes/A.md'), 'drift\n');
  await adapter.reconcilePullOnly();
  assert.equal(await fs.readFile(path.join(vault, 'Notes/A.md'), 'utf8'), remote);
  assert.equal((await findFiles(path.join(vault, '.web-vault-sync-quarantine'))).length, 1);
});

async function findFiles(directory: string): Promise<string[]> {
  const found: string[] = []; for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, item.name); if (item.isDirectory()) found.push(...await findFiles(candidate)); else found.push(candidate);
  } return found;
}

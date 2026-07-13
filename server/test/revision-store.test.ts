import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256Text, type SyncEvent } from '@webobsidian/sync-core';
import { RevisionStore, scanVaultSnapshot } from '../src/sync/revision-store.js';

async function temp(t: TestContext): Promise<{ root: string; data: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-revisions-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-revision-data-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]));
  return { root, data };
}

test('bootstrap scans files and empty directories while enforcing exclusions', async (t) => {
  const { root } = await temp(t);
  await fs.mkdir(path.join(root, 'Notes'));
  await fs.mkdir(path.join(root, 'Empty'));
  await fs.mkdir(path.join(root, '.obsidian'));
  await fs.writeFile(path.join(root, 'Notes', 'A.md'), 'alpha');
  await fs.writeFile(path.join(root, '.obsidian', 'workspace.json'), '{}');
  await fs.writeFile(path.join(root, '.DS_Store'), 'ignored');
  const entries = await scanVaultSnapshot(root);
  assert.deepEqual(entries.map((entry) => entry.path), ['Empty', 'Notes', 'Notes/A.md']);
  const note = entries.find((entry) => entry.path === 'Notes/A.md');
  assert.equal(note?.hash, sha256Text('alpha'));
  assert.equal(note?.size, 5);
  assert.equal(note?.revision, 1);
  assert.equal(note?.sequence, 0);
});

test('bootstrap checkpoint resume reuses identities and rehashes only changed files', async (t) => {
  const { root } = await temp(t);
  await fs.writeFile(path.join(root, 'A.md'), 'a');
  await fs.writeFile(path.join(root, 'B.md'), 'b');
  const partial = await scanVaultSnapshot(root);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fs.writeFile(path.join(root, 'B.md'), 'changed');
  await fs.writeFile(path.join(root, 'C.md'), 'new');
  let checkpointed = 0;
  const resumed = await scanVaultSnapshot(root, partial, async () => { checkpointed += 1; });
  assert.equal(checkpointed, 1);
  assert.equal(resumed.find((entry) => entry.path === 'A.md')?.entryId, partial.find((entry) => entry.path === 'A.md')?.entryId);
  assert.equal(resumed.find((entry) => entry.path === 'B.md')?.entryId, partial.find((entry) => entry.path === 'B.md')?.entryId);
  assert.equal(resumed.find((entry) => entry.path === 'B.md')?.hash, sha256Text('changed'));
  assert.ok(resumed.find((entry) => entry.path === 'C.md')?.entryId);
});

test('bootstrap identity is persisted and not regenerated', async (t) => {
  const { root, data } = await temp(t);
  await fs.writeFile(path.join(root, 'A.md'), 'a');
  const first = await new RevisionStore(data).initializeFromVault(root);
  const second = await new RevisionStore(data).initializeFromVault(root);
  assert.equal(second.entries[0]?.entryId, first.entries[0]?.entryId);
});

test('committed events advance snapshot and preserve stable identity through rename/delete', async (t) => {
  const { root, data } = await temp(t);
  await fs.writeFile(path.join(root, 'A.md'), 'a');
  const store = new RevisionStore(data);
  const initial = await store.initializeFromVault(root);
  const entry = initial.entries[0]!;
  const rename: SyncEvent = {
    sequence: 1,
    eventId: 'event_revision_0001',
    actor: { type: 'web', id: 'browser_revision_1' },
    operation: 'rename',
    entryId: entry.entryId,
    path: 'B.md',
    oldPath: 'A.md',
    baseRevision: 1,
    revision: 2,
    hash: entry.hash,
    size: entry.size,
    occurredAt: '2026-07-12T00:00:00.000Z',
  };
  await store.applyCommittedEvent(rename);
  assert.equal((await store.getById(entry.entryId))?.path, 'B.md');
  assert.equal((await store.getByPath('b.MD'))?.entryId, entry.entryId);
  const deletion: SyncEvent = {
    sequence: 2,
    eventId: 'event_revision_0002',
    actor: rename.actor,
    operation: 'delete',
    entryId: entry.entryId,
    path: 'B.md',
    baseRevision: 2,
    revision: 3,
    hash: null,
    ...(entry.hash ? { previousHash: entry.hash } : {}),
    size: 0,
    occurredAt: '2026-07-12T00:00:01.000Z',
  };
  await store.applyCommittedEvent(deletion);
  assert.equal((await store.getById(entry.entryId))?.deleted, true);
  assert.equal(await store.getByPath('B.md'), null);
});

test('bootstrap rejects case-fold collisions', async (t) => {
  const { root } = await temp(t);
  await fs.writeFile(path.join(root, 'A.md'), 'a');
  await fs.writeFile(path.join(root, 'a.md'), 'b');
  await assert.rejects(() => scanVaultSnapshot(root), /collision/);
});

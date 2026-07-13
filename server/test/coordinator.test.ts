import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256Text, type SyncOperation } from '@picassio/sync-core';
import { MergeBaseStore } from '../src/sync/base-store.js';
import { BlobStore } from '../src/sync/blob-store.js';
import { ConflictStore } from '../src/sync/conflict-store.js';
import { CoordinatorError, LEGACY_WEB_ACTOR, SyncCoordinator } from '../src/sync/coordinator.js';
import { JournalStore } from '../src/sync/journal.js';
import { RevisionStore } from '../src/sync/revision-store.js';

const actor = { type: 'device' as const, id: 'device_coordinator_1' };

async function setup(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-coordinator-vault-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-coordinator-data-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]));
  const coordinator = new SyncCoordinator({ vaultRoot: root, dataDir: data });
  await coordinator.initialize();
  assert.equal(coordinator.health().initialized, true);
  assert.equal(coordinator.health().readOnly, false);
  assert.equal(coordinator.health().reason, null);
  return { root, data, coordinator };
}

function create(pathValue: string, content: string, sequence = 1): SyncOperation {
  return {
    operation: 'create',
    clientSequence: sequence,
    idempotencyKey: `device:create:${sequence}:test`,
    path: pathValue,
    kind: 'file',
    content: { hash: sha256Text(content), size: Buffer.byteLength(content), inlineText: content },
  };
}

test('coordinator commits create-modify-rename-delete as revisioned journal events', async (t) => {
  const { root, data, coordinator } = await setup(t);
  const committed: number[] = [];
  coordinator.subscribe((event) => { committed.push(event.sequence); });

  const created = await coordinator.apply(create('Note.md', 'one'), actor);
  assert.equal(await fs.readFile(path.join(root, 'Note.md'), 'utf8'), 'one');
  const modified = await coordinator.apply({
    operation: 'modify', clientSequence: 2, idempotencyKey: 'device:modify:2:test',
    entryId: created.entryId!, baseRevision: created.revision!,
    content: { hash: sha256Text('two'), size: 3, inlineText: 'two' },
  }, actor);
  assert.equal(await fs.readFile(path.join(root, 'Note.md'), 'utf8'), 'two');
  assert.equal((await new MergeBaseStore(data).get(created.entryId!, 1))?.hash, sha256Text('one'));
  assert.equal((await new BlobStore(data).get(sha256Text('two')))?.size, 3);
  const renamed = await coordinator.apply({
    operation: 'rename', clientSequence: 3, idempotencyKey: 'device:rename:3:test',
    entryId: created.entryId!, baseRevision: modified.revision!, path: 'Renamed.md',
  }, actor);
  assert.equal(await fs.readFile(path.join(root, 'Renamed.md'), 'utf8'), 'two');
  const deleted = await coordinator.apply({
    operation: 'delete', clientSequence: 4, idempotencyKey: 'device:delete:4:test',
    entryId: created.entryId!, baseRevision: renamed.revision!,
  }, actor);

  assert.equal(deleted.revision, 4);
  assert.equal(await fs.stat(path.join(root, 'Renamed.md')).catch(() => null), null);
  assert.deepEqual((await new JournalStore(data).replay()).map((event) => event.operation), ['create', 'modify', 'rename', 'delete']);
  const entry = await new RevisionStore(data).getById(created.entryId!);
  assert.equal(entry?.deleted, true);
  assert.equal(entry?.path, 'Renamed.md');
  assert.deepEqual(committed, [1, 2, 3, 4]);
  assert.deepEqual(await fs.readdir(path.join(data, 'sync', 'transactions')), []);
});

test('coordinator returns durable result for an exact retry and rejects reused client sequence', async (t) => {
  const { data, coordinator } = await setup(t);
  const operation = create('A.md', 'a');
  const first = await coordinator.apply(operation, actor);
  assert.deepEqual(await coordinator.apply(operation, actor), first);
  await assert.rejects(() => coordinator.apply({ ...create('B.md', 'b'), idempotencyKey: operation.idempotencyKey }, actor),
    (error: unknown) => error instanceof CoordinatorError && error.code === 'client_sequence_reused');
  assert.equal(await new JournalStore(data).latestSequence(), 1);
  const metrics = coordinator.health().metrics;
  assert.equal(metrics.operations.accepted, 2);
  assert.equal(metrics.operations.deduplicated, 1);
  assert.equal(metrics.operations.rejected, 1);
  assert.equal(metrics.latency.count, 3);
});

test('coordinator conflict-copies unavailable bases and rejects collisions/hash mismatches', async (t) => {
  const { data, coordinator } = await setup(t);
  const first = await coordinator.apply(create('A.md', 'a'), actor);
  await coordinator.apply(create('B.md', 'b', 2), actor);

  const stale = await coordinator.apply({
    operation: 'modify', clientSequence: 3, idempotencyKey: 'device:stale:3:test',
    entryId: first.entryId!, baseRevision: 0,
    content: { hash: sha256Text('c'), size: 1, inlineText: 'c' },
  }, actor);
  assert.equal(stale.status, 'conflict');
  await assert.rejects(() => coordinator.apply({
    operation: 'rename', clientSequence: 4, idempotencyKey: 'device:collision:4:test',
    entryId: first.entryId!, baseRevision: first.revision!, path: 'b.MD',
  }, actor), (error: unknown) => error instanceof CoordinatorError && error.code === 'path_collision');
  await assert.rejects(() => coordinator.apply({
    ...create('C.md', 'actual', 5),
    content: { hash: sha256Text('wrong'), size: 6, inlineText: 'actual' },
  }, actor), (error: unknown) => error instanceof CoordinatorError && error.code === 'hash_mismatch');
  assert.equal(await new JournalStore(data).latestSequence(), 3);
});

test('coordinator converges duplicate creates with identical kind/hash without an event', async (t) => {
  const { data, coordinator } = await setup(t);
  const first = await coordinator.apply(create('Same.md', 'same', 1), actor);
  const second = await coordinator.apply(create('Same.md', 'same', 2), actor);
  assert.equal(second.entryId, first.entryId);
  assert.equal(second.revision, first.revision);
  assert.equal(await new JournalStore(data).latestSequence(), 1);
});

test('coordinator rebases rename over intervening modify and modify over metadata rename', async (t) => {
  const { root, coordinator } = await setup(t);
  const created = await coordinator.apply(create('Identity.md', 'base\n', 1), actor);
  const modified = await coordinator.apply({
    operation: 'modify', clientSequence: 2, idempotencyKey: 'device:identity:modify:2',
    entryId: created.entryId!, baseRevision: 1,
    content: { hash: sha256Text('server\n'), size: 7, inlineText: 'server\n' },
  }, actor);
  const renamed = await coordinator.apply({
    operation: 'rename', clientSequence: 3, idempotencyKey: 'device:identity:rename:3',
    entryId: created.entryId!, baseRevision: 1, path: 'Moved.md',
  }, actor);
  assert.equal(renamed.revision, 3);
  assert.equal(await fs.readFile(path.join(root, 'Moved.md'), 'utf8'), 'server\n');

  const staleAfterRename = await coordinator.apply({
    operation: 'modify', clientSequence: 4, idempotencyKey: 'device:identity:stale:4',
    entryId: created.entryId!, baseRevision: modified.revision!,
    content: { hash: sha256Text('client\n'), size: 7, inlineText: 'client\n' },
  }, actor);
  assert.equal(staleAfterRename.status, 'merged');
  assert.equal(staleAfterRename.path, 'Moved.md');
  assert.equal(await fs.readFile(path.join(root, 'Moved.md'), 'utf8'), 'client\n');
});

test('coordinator deterministically diff3-merges a stale text modification with independent edits', async (t) => {
  const { root, coordinator } = await setup(t);
  const created = await coordinator.apply(create('Merge.md', 'a\nb\nc\n'), actor);
  await coordinator.apply({
    operation: 'modify', clientSequence: 2, idempotencyKey: 'device:merge:server:2',
    entryId: created.entryId!, baseRevision: 1,
    content: { hash: sha256Text('A\nb\nc\n'), size: 6, inlineText: 'A\nb\nc\n' },
  }, actor);
  const merged = await coordinator.apply({
    operation: 'modify', clientSequence: 3, idempotencyKey: 'device:merge:client:3',
    entryId: created.entryId!, baseRevision: 1,
    content: { hash: sha256Text('a\nb\nC\n'), size: 6, inlineText: 'a\nb\nC\n' },
  }, actor);
  assert.equal(merged.status, 'merged');
  assert.equal(merged.revision, 3);
  assert.equal(await fs.readFile(path.join(root, 'Merge.md'), 'utf8'), 'A\nb\nC\n');
});

test('coordinator creates a durable conflict copy when stale text edits overlap', async (t) => {
  const { root, data, coordinator } = await setup(t);
  const created = await coordinator.apply(create('Overlap.md', 'one\n'), actor);
  await coordinator.apply({
    operation: 'modify', clientSequence: 2, idempotencyKey: 'device:overlap:server:2',
    entryId: created.entryId!, baseRevision: 1,
    content: { hash: sha256Text('server\n'), size: 7, inlineText: 'server\n' },
  }, actor);
  const operation = {
    operation: 'modify' as const, clientSequence: 3, idempotencyKey: 'device:overlap:client:3',
    entryId: created.entryId!, baseRevision: 1,
    content: { hash: sha256Text('client\n'), size: 7, inlineText: 'client\n' },
  };
  const conflictResult = await coordinator.apply(operation, actor);
  assert.equal(conflictResult.status, 'conflict');
  assert.ok(conflictResult.conflictId);
  assert.equal(await fs.readFile(path.join(root, 'Overlap.md'), 'utf8'), 'server\n');
  assert.equal(await fs.readFile(path.join(root, conflictResult.path!), 'utf8'), 'client\n');
  const conflict = await new ConflictStore(data).get(conflictResult.conflictId!);
  assert.equal(conflict?.status, 'unresolved');
  assert.equal(conflict?.conflictPath, conflictResult.path);
  assert.deepEqual(await coordinator.apply(operation, actor), conflictResult);
  const resolutionMetadata = { clientSequence: 4, idempotencyKey: 'device:overlap:resolve:4' };
  const resolved = await coordinator.resolveConflict(conflictResult.conflictId!, 'keep-client', actor, resolutionMetadata);
  assert.equal(resolved.conflict.status, 'resolved');
  assert.equal(await fs.readFile(path.join(root, 'Overlap.md'), 'utf8'), 'client\n');
  assert.deepEqual(await coordinator.resolveConflict(conflictResult.conflictId!, 'keep-client', actor, resolutionMetadata), resolved);
  assert.equal(await new JournalStore(data).latestSequence(), 4);
});

test('coordinator preserves both versions for divergent binary modifications', async (t) => {
  const { root, data, coordinator } = await setup(t);
  const created = await coordinator.apply(create('Binary.bin', 'base', 1), actor);
  await coordinator.apply({
    operation: 'modify', clientSequence: 2, idempotencyKey: 'device:binary:server:2',
    entryId: created.entryId!, baseRevision: 1,
    content: { hash: sha256Text('server'), size: 6, inlineText: 'server' },
  }, actor);
  const conflict = await coordinator.apply({
    operation: 'modify', clientSequence: 3, idempotencyKey: 'device:binary:client:3',
    entryId: created.entryId!, baseRevision: 1,
    content: { hash: sha256Text('client'), size: 6, inlineText: 'client' },
  }, actor);
  assert.equal(conflict.status, 'conflict');
  assert.equal((await new ConflictStore(data).get(conflict.conflictId!))?.kind, 'binary');
  assert.equal(await fs.readFile(path.join(root, 'Binary.bin'), 'utf8'), 'server');
  assert.equal(await fs.readFile(path.join(root, conflict.path!), 'utf8'), 'client');
  assert.deepEqual([...await coordinator.protectedConflictBlobHashes()].sort(), [
    sha256Text('base'), sha256Text('client'), sha256Text('server'),
  ].sort());
});

test('coordinator records delete/rename conflicts and preserves tombstoned modifications as copies', async (t) => {
  const { root, data, coordinator } = await setup(t);
  const created = await coordinator.apply(create('Matrix.md', 'base', 1), actor);
  const modified = await coordinator.apply({
    operation: 'modify', clientSequence: 2, idempotencyKey: 'device:matrix:modify:2',
    entryId: created.entryId!, baseRevision: 1,
    content: { hash: sha256Text('server'), size: 6, inlineText: 'server' },
  }, actor);
  const deleteConflict = await coordinator.apply({
    operation: 'delete', clientSequence: 3, idempotencyKey: 'device:matrix:delete:3',
    entryId: created.entryId!, baseRevision: 1,
  }, actor);
  assert.equal(deleteConflict.status, 'conflict');
  assert.equal(await fs.readFile(path.join(root, 'Matrix.md'), 'utf8'), 'server');
  assert.equal((await new ConflictStore(data).get(deleteConflict.conflictId!))?.kind, 'delete');

  const renamed = await coordinator.apply({
    operation: 'rename', clientSequence: 4, idempotencyKey: 'device:matrix:rename:4',
    entryId: created.entryId!, baseRevision: modified.revision!, path: 'Server-name.md',
  }, actor);
  const renameConflict = await coordinator.apply({
    operation: 'rename', clientSequence: 5, idempotencyKey: 'device:matrix:rename:5',
    entryId: created.entryId!, baseRevision: modified.revision!, path: 'Client-name.md',
  }, actor);
  assert.equal(renameConflict.status, 'conflict');
  assert.equal(renameConflict.path, 'Server-name.md');
  const convergedRename = await coordinator.apply({
    operation: 'rename', clientSequence: 6, idempotencyKey: 'device:matrix:rename:6',
    entryId: created.entryId!, baseRevision: modified.revision!, path: 'Server-name.md',
  }, actor);
  assert.equal(convergedRename.revision, renamed.revision);

  const deleted = await coordinator.apply({
    operation: 'delete', clientSequence: 7, idempotencyKey: 'device:matrix:delete:7',
    entryId: created.entryId!, baseRevision: renamed.revision!,
  }, actor);
  const tombstoneConflict = await coordinator.apply({
    operation: 'modify', clientSequence: 8, idempotencyKey: 'device:matrix:tombstone:8',
    entryId: created.entryId!, baseRevision: renamed.revision!,
    content: { hash: sha256Text('resurrect'), size: 9, inlineText: 'resurrect' },
  }, actor);
  assert.equal(deleted.hash, null);
  assert.equal(tombstoneConflict.status, 'conflict');
  assert.equal(await fs.readFile(path.join(root, tombstoneConflict.path!), 'utf8'), 'resurrect');
});

test('coordinator rejects symlink ancestors without writing outside the vault', async (t) => {
  const { root, data, coordinator } = await setup(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-symlink-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, 'Link'), 'dir');
  await assert.rejects(() => coordinator.apply(create('Link/escaped.md', 'forbidden'), actor), /symbolic links/);
  assert.equal(await fs.stat(path.join(outside, 'escaped.md')).catch(() => null), null);
  assert.equal(await new JournalStore(data).latestSequence(), 0);
});

test('coordinator prevents overwrite after direct filesystem divergence', async (t) => {
  const { root, data, coordinator } = await setup(t);
  const first = await coordinator.apply(create('A.md', 'original'), actor);
  await fs.writeFile(path.join(root, 'A.md'), 'outside');
  await assert.rejects(() => coordinator.apply({
    operation: 'modify', clientSequence: 2, idempotencyKey: 'device:outside:2:test',
    entryId: first.entryId!, baseRevision: first.revision!,
    content: { hash: sha256Text('mine'), size: 4, inlineText: 'mine' },
  }, actor), (error: unknown) => error instanceof CoordinatorError && error.code === 'revision_conflict');
  assert.equal(await fs.readFile(path.join(root, 'A.md'), 'utf8'), 'outside');
  assert.equal(await new JournalStore(data).latestSequence(), 1);
});

test('coordinator trash/restore reuses identity when free and allocates a new identity on collision', async (t) => {
  const { root, coordinator } = await setup(t);
  const created = await coordinator.apply(create('Trash.md', 'recover', 1), actor);
  const deleted = await coordinator.apply({
    operation: 'delete', clientSequence: 2, idempotencyKey: 'device:trash:delete:2',
    entryId: created.entryId!, baseRevision: created.revision!,
  }, actor);
  const record = (await coordinator.listTrash())[0]!;
  assert.equal(record.entryId, created.entryId);
  assert.equal(await fs.readFile(path.join(root, record.trashPath), 'utf8'), 'recover');
  const restored = await coordinator.restoreTrash(
    record.trashPath, actor,
    { clientSequence: 3, idempotencyKey: 'device:trash:restore:3' },
  );
  assert.equal(restored.entryId, created.entryId);
  assert.equal(restored.revision, deleted.revision! + 1);
  assert.equal(await fs.readFile(path.join(root, 'Trash.md'), 'utf8'), 'recover');
  assert.deepEqual(await coordinator.listTrash(), []);

  await coordinator.apply({
    operation: 'delete', clientSequence: 4, idempotencyKey: 'device:trash:delete:4',
    entryId: restored.entryId!, baseRevision: restored.revision!,
  }, actor);
  const secondRecord = (await coordinator.listTrash())[0]!;
  const replacement = await coordinator.apply(create('Trash.md', 'replacement', 5), actor);
  const collisionRestore = await coordinator.restoreTrash(
    secondRecord.trashPath, actor,
    { clientSequence: 6, idempotencyKey: 'device:trash:restore:6' },
  );
  assert.notEqual(collisionRestore.entryId, restored.entryId);
  assert.notEqual(collisionRestore.entryId, replacement.entryId);
  assert.match(collisionRestore.path!, /\.restored-/);
  assert.equal(await fs.readFile(path.join(root, collisionRestore.path!), 'utf8'), 'recover');
  assert.equal(await fs.readFile(path.join(root, 'Trash.md'), 'utf8'), 'replacement');
});

test('coordinator expands recursive copy into ordered new identities and events', async (t) => {
  const { root, data, coordinator } = await setup(t);
  const folder = await coordinator.apply({
    operation: 'mkdir', clientSequence: 1, idempotencyKey: 'device:copy:mkdir:1', path: 'Source', kind: 'directory',
  }, actor);
  const original = await coordinator.apply(create('Source/A.md', 'a', 2), actor);
  const results = await coordinator.copyPath(
    'Source', 'Destination', LEGACY_WEB_ACTOR, () => coordinator.nextLegacyOperationMetadata(),
  );
  assert.deepEqual(results.map((result) => result.path), ['Destination', 'Destination/A.md']);
  assert.notEqual(results[0]?.entryId, folder.entryId);
  assert.notEqual(results[1]?.entryId, original.entryId);
  assert.equal(await fs.readFile(path.join(root, 'Destination', 'A.md'), 'utf8'), 'a');
  assert.deepEqual((await new JournalStore(data).replay()).map((event) => event.sequence), [1, 2, 3, 4]);
});

test('coordinator performs case-only rename through recoverable identity-preserving path', async (t) => {
  const { root, coordinator } = await setup(t);
  const created = await coordinator.apply(create('case.md', 'case', 1), actor);
  const renamed = await coordinator.apply({
    operation: 'rename', clientSequence: 2, idempotencyKey: 'device:case-rename:2',
    entryId: created.entryId!, baseRevision: created.revision!, path: 'Case.md',
  }, actor);
  assert.equal(renamed.entryId, created.entryId);
  assert.equal(await fs.readFile(path.join(root, 'Case.md'), 'utf8'), 'case');
  assert.equal(await fs.stat(path.join(root, 'case.md')).catch(() => null), null);
});

test('coordinator handles explicit empty directories and rejects non-empty rmdir', async (t) => {
  const { root, coordinator } = await setup(t);
  const directory = await coordinator.apply({
    operation: 'mkdir', clientSequence: 1, idempotencyKey: 'device:mkdir:1:test', path: 'Folder', kind: 'directory',
  }, actor);
  await coordinator.apply(create('Folder/A.md', 'a', 2), actor);
  await assert.rejects(() => coordinator.apply({
    operation: 'rmdir', clientSequence: 3, idempotencyKey: 'device:rmdir:3:test',
    entryId: directory.entryId!, baseRevision: directory.revision!,
  }, actor), /not empty/);
  assert.equal((await fs.stat(path.join(root, 'Folder'))).isDirectory(), true);
});

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256Text, type SyncEvent } from '@webobsidian/sync-core';
import { BlobStore } from '../src/sync/blob-store.js';
import { JournalStore } from '../src/sync/journal.js';
import { CursorExpiredError, SyncRetentionManager } from '../src/sync/retention.js';
import { RevisionStore } from '../src/sync/revision-store.js';

async function setup(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-retention-vault-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-retention-data-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]));
  const revisions = new RevisionStore(data);
  await revisions.initializeFromVault(root);
  return { root, data, revisions };
}

function create(sequence: number, entry: string, content: string): SyncEvent {
  return {
    sequence, eventId: `event_retention_${sequence}`, actor: { type: 'server-fs', id: 'server_retention_1' },
    operation: 'create', entryId: entry, path: `${entry}.md`, baseRevision: null, revision: 1,
    hash: sha256Text(content), size: content.length, occurredAt: `2020-01-0${sequence}T00:00:00.000Z`,
  };
}

function deletion(sequence: number, previous: SyncEvent): SyncEvent {
  return {
    sequence, eventId: `event_retention_${sequence}`, actor: previous.actor,
    operation: 'delete', entryId: previous.entryId, path: previous.path, baseRevision: 1, revision: 2,
    hash: null, previousHash: previous.hash!, size: 0, occurredAt: `2020-01-0${sequence}T00:00:00.000Z`,
  };
}

test('compaction backs up metadata and removes only acknowledged expired history', async (t) => {
  const { data, revisions } = await setup(t);
  const journal = new JournalStore(data, 2);
  const a = create(1, 'entry_retention_a', 'a');
  const b = create(3, 'entry_retention_b', 'b');
  const c = create(5, 'entry_retention_c', 'c');
  const events = [a, deletion(2, a), b, deletion(4, b), c];
  for (const event of events) {
    await journal.append(event);
    await revisions.applyCommittedEvent(event);
  }
  const blobs = new BlobStore(data);
  const orphanHash = sha256Text('orphan');
  await blobs.put([Buffer.from('orphan')], orphanHash, 6);
  await fs.utimes(blobs.file(orphanHash), new Date('2020-01-01'), new Date('2020-01-01'));

  const manager = new SyncRetentionManager(data);
  const result = await manager.compact({
    now: new Date('2022-01-01T00:00:00Z'), retentionMs: 365 * 24 * 60 * 60 * 1000,
    minimumAcknowledgedSequence: 4, maxBasesPerEntry: 3,
  });
  assert.equal(result.throughSequence, 4);
  assert.deepEqual(result.removedSegments, [1, 2]);
  assert.equal(result.removedTombstones, 2);
  assert.equal(result.removedBlobs, 1);
  assert.ok(result.backupDirectory);
  assert.equal((await fs.stat(path.join(result.backupDirectory!, 'revisions.json'))).isFile(), true);
  assert.deepEqual((await new RevisionStore(data).load())?.entries.map((entry) => entry.entryId), ['entry_retention_c']);
  await assert.rejects(() => manager.assertCursorAvailable(0), CursorExpiredError);
  await manager.assertCursorAvailable(4);
});

test('future-dated events caused by clock skew are never compacted early', async (t) => {
  const { data, revisions } = await setup(t);
  const event = { ...create(1, 'entry_future_clock', 'future'), occurredAt: '2099-01-01T00:00:00.000Z' };
  await new JournalStore(data, 1).append(event); await revisions.applyCommittedEvent(event);
  const result = await new SyncRetentionManager(data).compact({
    now: new Date('2026-07-13T00:00:00.000Z'), retentionMs: 0,
    minimumAcknowledgedSequence: 1, maxBasesPerEntry: 1,
  });
  assert.equal(result.throughSequence, 0);
  assert.equal(await new JournalStore(data).latestSequence(), 1);
});

test('compaction is disabled when no retained-device acknowledgement boundary exists', async (t) => {
  const { data } = await setup(t);
  const result = await new SyncRetentionManager(data).compact({
    retentionMs: 0, minimumAcknowledgedSequence: null, maxBasesPerEntry: 1,
  });
  assert.equal(result.backupDirectory, null);
  assert.deepEqual(result.removedSegments, []);
});

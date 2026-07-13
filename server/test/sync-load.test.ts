import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256Text, type SyncEntry, type SyncEvent } from '@webobsidian/sync-core';
import { JournalStore } from '../src/sync/journal.js';
import { ManifestSnapshotStore } from '../src/sync/manifest-snapshots.js';
import { RevisionStore } from '../src/sync/revision-store.js';

function event(sequence: number): SyncEvent {
  return {
    sequence, eventId: `event_load_${String(sequence).padStart(8, '0')}`,
    actor: { type: 'server-fs', id: 'server_load_test_1' }, operation: 'create',
    entryId: `entry_load_${String(sequence).padStart(8, '0')}`, path: `Load/${sequence}.md`,
    baseRevision: null, revision: 1, hash: sha256Text(String(sequence)), size: String(sequence).length,
    occurredAt: new Date(1_700_000_000_000 + sequence).toISOString(),
  };
}

test('50k-entry manifest remains snapshot-consistent and bounded while paginating', (t) => {
  const entries: SyncEntry[] = Array.from({ length: 50_000 }, (_, index) => ({
    entryId: `entry_manifest_${String(index).padStart(8, '0')}`,
    path: `Load/${String(index).padStart(8, '0')}.md`, kind: 'file' as const,
    revision: 1, hash: sha256Text(String(index)), size: String(index).length,
    modifiedAt: '2026-07-13T00:00:00.000Z', deleted: false, sequence: 0,
  }));
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const snapshots = new ManifestSnapshotStore();
  let page = snapshots.create(entries, 123, 1000);
  let count = page.entries.length;
  entries[0]!.path = 'mutated-after-snapshot.md';
  assert.notEqual(page.entries[0]?.path, entries[0]?.path);
  while (page.nextCursor) {
    page = snapshots.page(page.nextCursor, 1000);
    assert.equal(page.snapshotSequence, 123);
    count += page.entries.length;
  }
  assert.equal(count, 50_000);
  const elapsed = performance.now() - started;
  t.diagnostic(`50k immutable manifest snapshot + 50 pages ${elapsed.toFixed(1)} ms`);
  assert.ok(process.memoryUsage().heapUsed - before < 128 * 1024 * 1024);
});

test('50k-entry revision projection updates without rewriting the full JSON snapshot', { timeout: 30_000 }, async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-load-revisions-'));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  const entries: SyncEntry[] = Array.from({ length: 50_000 }, (_, index) => ({
    entryId: `entry_projection_${String(index).padStart(8, '0')}`,
    path: `Load/${String(index).padStart(8, '0')}.md`, kind: 'file', revision: 1,
    hash: sha256Text(String(index)), size: String(index).length,
    modifiedAt: '2026-07-13T00:00:00.000Z', deleted: false, sequence: 0,
  }));
  const store = new RevisionStore(data); await store.replaceFromReplay(entries, 0);
  const target = entries[25_000]!; const beforeMemory = process.memoryUsage().heapUsed; const started = performance.now();
  await store.applyCommittedEvent({
    sequence: 1, eventId: 'event_projection_load_0001', actor: { type: 'device', id: 'device_projection_load_1' },
    operation: 'modify', entryId: target.entryId, path: target.path, baseRevision: 1, revision: 2,
    previousHash: target.hash!, hash: sha256Text('updated'), size: 7, occurredAt: '2026-07-13T00:00:01.000Z',
  });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 500, `projection update took ${elapsed.toFixed(1)} ms`);
  t.diagnostic(`50k projection update ${elapsed.toFixed(1)} ms; heap delta ${((process.memoryUsage().heapUsed - beforeMemory) / 1024 / 1024).toFixed(1)} MiB`);
  assert.equal((await store.getById(target.entryId))?.revision, 2);
  assert.ok(process.memoryUsage().heapUsed - beforeMemory < 128 * 1024 * 1024);
});

test('large journal serves a 500-client reconnect storm from bounded replay cache', async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-load-journal-'));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  const journal = new JournalStore(data, 100);
  for (let sequence = 1; sequence <= 1_000; sequence += 1) await journal.append(event(sequence));
  assert.equal((await journal.segments()).every((segment) => segment.eventCount <= 100), true);
  await journal.replay(); // warm validated cache
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const reconnects = await Promise.all(Array.from({ length: 500 }, () => journal.replay(900)));
  const elapsed = performance.now() - started;
  t.diagnostic(`500 cached reconnect catch-ups ${elapsed.toFixed(1)} ms total (${(elapsed / 500).toFixed(3)} ms/client)`);
  assert.equal(reconnects.every((events) => events.length === 100 && events[0]?.sequence === 901), true);
  assert.ok(process.memoryUsage().heapUsed - before < 128 * 1024 * 1024);
});

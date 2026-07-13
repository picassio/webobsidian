import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256Text, type SyncEvent } from '@webobsidian/sync-core';
import { JournalStore } from '../src/sync/journal.js';

function event(sequence: number): SyncEvent {
  return {
    sequence,
    eventId: `event_property_${String(sequence).padStart(6, '0')}`,
    actor: { type: 'server-fs', id: 'server_property_test' },
    operation: 'create',
    entryId: `entry_property_${String(sequence).padStart(6, '0')}`,
    path: `Generated/${sequence}.bin`,
    baseRevision: null,
    revision: 1,
    hash: sha256Text(String(sequence)),
    size: String(sequence).length,
    occurredAt: new Date(1_700_000_000_000 + sequence).toISOString(),
  };
}

test('journal replay/rotation invariants hold across segment limits and long sequences', async (t) => {
  for (const limit of [1, 2, 3, 7, 31]) {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), `webobsidian-property-${limit}-`));
    t.after(() => fs.rm(data, { recursive: true, force: true }));
    const journal = new JournalStore(data, limit);
    for (let sequence = 1; sequence <= 137; sequence += 1) await journal.append(event(sequence));
    const replayed = await journal.replay();
    assert.equal(replayed.length, 137);
    assert.deepEqual(replayed.map((item) => item.sequence), Array.from({ length: 137 }, (_, index) => index + 1));
    const segments = await journal.segments();
    assert.equal(segments.every((segment) => segment.eventCount <= limit), true);
    assert.equal(segments.slice(0, -1).every((segment) => segment.sealed), true);
    for (const cursor of [0, 1, 17, 68, 136, 137]) {
      assert.deepEqual((await journal.replay(cursor)).map((item) => item.sequence),
        Array.from({ length: 137 - cursor }, (_, index) => cursor + index + 1));
    }
  }
});

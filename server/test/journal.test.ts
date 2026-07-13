import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { SyncEvent } from '@picassio/sync-core';
import { JournalStore } from '../src/sync/journal.js';

async function dataDir(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-journal-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function event(sequence: number): SyncEvent {
  return {
    sequence,
    eventId: `event_journal_${String(sequence).padStart(4, '0')}`,
    actor: { type: 'web', id: 'browser_journal_1' },
    operation: 'create',
    entryId: `entry_journal_${String(sequence).padStart(4, '0')}`,
    path: `Notes/${sequence}.md`,
    baseRevision: null,
    revision: 1,
    hash: String(sequence % 10).repeat(64),
    size: sequence,
    occurredAt: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
  };
}

test('journal appends contiguous events and rotates immutable bounded segments', async (t) => {
  const directory = await dataDir(t);
  const journal = new JournalStore(directory, 2);
  await journal.append(event(1));
  await journal.append(event(2));
  await journal.append(event(3));
  assert.equal(await journal.latestSequence(), 3);
  assert.deepEqual((await journal.replay()).map((item) => item.sequence), [1, 2, 3]);
  assert.deepEqual((await journal.replay(1)).map((item) => item.sequence), [2, 3]);
  const files = (await fs.readdir(path.join(directory, 'sync', 'journal'))).filter((name) => /^\d{8}\.json$/.test(name));
  assert.deepEqual(files.sort(), ['00000001.json', '00000002.json']);
  const first = JSON.parse(await fs.readFile(path.join(directory, 'sync', 'journal', '00000001.json'), 'utf8')) as { payload: { sealed: boolean } };
  assert.equal(first.payload.sealed, true);
});

test('journal rejects sequence gaps without poisoning later appends', async (t) => {
  const directory = await dataDir(t);
  const journal = new JournalStore(directory);
  await journal.append(event(1));
  await assert.rejects(() => journal.append(event(3)), /must be 2/);
  await journal.append(event(2));
  assert.equal(await journal.latestSequence(), 2);
});

test('journal serializes concurrent append requests', async (t) => {
  const directory = await dataDir(t);
  const journal = new JournalStore(directory);
  await Promise.all([journal.append(event(1)), journal.append(event(2)), journal.append(event(3))]);
  assert.deepEqual((await journal.replay()).map((item) => item.sequence), [1, 2, 3]);
});

test('journal detects checksum tampering', async (t) => {
  const directory = await dataDir(t);
  const journal = new JournalStore(directory);
  await journal.append(event(1));
  const file = path.join(directory, 'sync', 'journal', '00000001.json');
  const body = JSON.parse(await fs.readFile(file, 'utf8')) as { payload: { lastSequence: number } };
  body.payload.lastSequence = 99;
  await fs.writeFile(file, JSON.stringify(body));
  await assert.rejects(() => journal.replay(), /checksum mismatch/);
});

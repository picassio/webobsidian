import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256Text, type SyncEvent } from '@picassio/sync-core';
import { TransactionIntentStore } from '../src/sync/intents.js';

async function setup(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-intent-'));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, source };
}

function result(event: SyncEvent) {
  return {
    idempotencyKey: 'device:2:intent-test',
    status: 'accepted' as const,
    eventId: event.eventId,
    sequence: event.sequence,
    entryId: event.entryId,
    revision: event.revision,
    hash: event.hash,
    path: event.path,
  };
}

function updateEvent(hash: string): SyncEvent {
  return {
    sequence: 2,
    eventId: 'event_intent_0002',
    actor: { type: 'web', id: 'browser_intent_1' },
    operation: 'modify',
    entryId: 'entry_intent_0001',
    path: 'Note.md',
    baseRevision: 1,
    revision: 2,
    hash,
    previousHash: sha256Text('old'),
    size: 3,
    occurredAt: '2026-07-12T00:00:00.000Z',
  };
}

test('intent stages fsynced previous/new content before durable prepared metadata', async (t) => {
  const { root, source } = await setup(t);
  const oldFile = path.join(source, 'old');
  const newFile = path.join(source, 'new');
  await fs.writeFile(oldFile, 'old');
  await fs.writeFile(newFile, 'new');
  const store = new TransactionIntentStore(root);
  const event = updateEvent(sha256Text('new'));
  const intent = await store.prepare({
    event,
    result: result(event),
    clientSequence: 2,
    operationFingerprint: sha256Text('modify-op'),
    targetPath: 'Note.md',
    previousPath: 'Note.md',
    newContentSource: newFile,
    previousContentSource: oldFile,
  });
  assert.equal(intent.status, 'prepared');
  assert.equal(intent.newContent?.hash, sha256Text('new'));
  assert.equal(intent.previousContent?.hash, sha256Text('old'));
  assert.equal(await fs.readFile(store.contentPath(intent, 'new')!, 'utf8'), 'new');
  assert.equal((await fs.stat(store.contentPath(intent, 'previous')!)).mode & 0o777, 0o600);
  assert.deepEqual((await store.list()).map((item) => item.transactionId), [intent.transactionId]);
});

test('materialization marker is idempotent and transaction cleanup is durable', async (t) => {
  const { root, source } = await setup(t);
  const newFile = path.join(source, 'new');
  await fs.writeFile(newFile, 'new');
  const store = new TransactionIntentStore(root);
  const event = updateEvent(sha256Text('new'));
  const intent = await store.prepare({
    event,
    result: result(event),
    clientSequence: 2,
    operationFingerprint: sha256Text('modify-op'),
    targetPath: 'Note.md',
    newContentSource: newFile,
  });
  assert.equal((await store.markMaterialized(intent.transactionId)).status, 'materialized');
  assert.equal((await store.markMaterialized(intent.transactionId)).status, 'materialized');
  await store.remove(intent.transactionId);
  assert.deepEqual(await store.list(), []);
});

test('failed intent validation removes staged transaction directory', async (t) => {
  const { root, source } = await setup(t);
  const newFile = path.join(source, 'new');
  await fs.writeFile(newFile, 'new');
  const store = new TransactionIntentStore(root);
  const event = updateEvent(sha256Text('new'));
  await assert.rejects(() => store.prepare({
    event,
    result: result(event),
    clientSequence: 2,
    operationFingerprint: sha256Text('modify-op'),
    targetPath: '../escape.md',
    newContentSource: newFile,
  }));
  const directory = path.join(root, 'sync', 'transactions');
  assert.deepEqual(await fs.readdir(directory), []);
});

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256Text, type OperationResult } from '@picassio/sync-core';
import { IdempotencyConflictError, IdempotencyStore } from '../src/sync/idempotency-store.js';

async function directory(t: TestContext): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-idempotency-'));
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}

function result(sequence: number, key: string): OperationResult {
  return {
    idempotencyKey: key,
    status: 'accepted',
    eventId: `event_idempotency_${sequence}`,
    sequence,
    entryId: `entry_idempotency_${sequence}`,
    revision: 1,
    hash: sha256Text(String(sequence)),
    path: `${sequence}.md`,
  };
}

test('idempotency store returns exact duplicate result and rejects reused key/sequence', async (t) => {
  const data = await directory(t);
  const store = new IdempotencyStore(data);
  const key = 'device:1:idempotency-test';
  const fingerprint = sha256Text('operation-one');
  const expected = result(1, key);
  await store.record('device_idempotency_1', 1, key, fingerprint, expected);
  assert.deepEqual(await store.lookup('device_idempotency_1', 1, key, fingerprint), expected);
  await assert.rejects(
    () => store.lookup('device_idempotency_1', 1, key, sha256Text('different')),
    (error: unknown) => error instanceof IdempotencyConflictError,
  );
  await assert.rejects(
    () => store.lookup('device_idempotency_1', 1, 'device:1:different-key', fingerprint),
    (error: unknown) => error instanceof IdempotencyConflictError,
  );
});

test('idempotency records are bounded while highest sequence still prevents old replay', async (t) => {
  const data = await directory(t);
  const store = new IdempotencyStore(data, 2);
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    const key = `device:${sequence}:bounded-test`;
    await store.record('device_idempotency_1', sequence, key, sha256Text(`op-${sequence}`), result(sequence, key));
  }
  assert.equal(await store.lookup('device_idempotency_1', 3, 'device:3:bounded-test', sha256Text('op-3')) !== null, true);
  await assert.rejects(
    () => store.lookup('device_idempotency_1', 1, 'device:1:evicted-key', sha256Text('op-1')),
    IdempotencyConflictError,
  );
});

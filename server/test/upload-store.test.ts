import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256Bytes } from '@webobsidian/sync-core';
import { BlobStore } from '../src/sync/blob-store.js';
import { UploadStore } from '../src/sync/upload-store.js';

async function directory(t: TestContext) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-upload-'));
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}

async function* chunk(value: Uint8Array) { yield value; }

test('resumable upload reports missing parts, enforces ownership, and assembles verified blob', async (t) => {
  const data = await directory(t);
  const bytes = Buffer.from('abcdefghij');
  const hash = sha256Bytes(bytes);
  const store = new UploadStore(data);
  const created = await store.create('device_upload_test_1', hash, bytes.length, 4);
  assert.deepEqual(created.missingParts, [0, 1, 2]);
  await store.putPart('device_upload_test_1', created.uploadId, 1, chunk(bytes.subarray(4, 8)));
  assert.deepEqual((await store.create('device_upload_test_1', hash, bytes.length, 4)).missingParts, [0, 2]);
  await assert.rejects(() => store.complete('device_upload_test_1', created.uploadId), /missing parts/);
  await assert.rejects(() => store.putPart('device_upload_other_1', created.uploadId, 0, chunk(bytes.subarray(0, 4))), /owned/);
  await store.putPart('device_upload_test_1', created.uploadId, 0, chunk(bytes.subarray(0, 4)));
  await store.putPart('device_upload_test_1', created.uploadId, 2, chunk(bytes.subarray(8)));
  assert.deepEqual(await store.complete('device_upload_test_1', created.uploadId), { hash, size: 10, deduplicated: false });
  assert.equal(await fs.readFile((await new BlobStore(data).get(hash))!.file, 'utf8'), 'abcdefghij');
});

test('existing blobs deduplicate and expired uploads are cleaned', async (t) => {
  const data = await directory(t);
  const bytes = Buffer.from('existing');
  const hash = sha256Bytes(bytes);
  await new BlobStore(data).put([bytes], hash, bytes.length);
  const store = new UploadStore(data, 60_000);
  const deduplicated = await store.create('device_upload_test_1', hash, bytes.length, 4);
  assert.deepEqual(deduplicated.missingParts, []);
  assert.equal((await store.complete('device_upload_test_1', deduplicated.uploadId)).deduplicated, true);
  const other = Buffer.from('other');
  const expiring = new UploadStore(data, 1);
  await expiring.create('device_upload_test_1', sha256Bytes(other), other.length, 4);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await expiring.cleanupExpired(), 1);
});

test('upload quota is enforced before reserving content', async (t) => {
  const data = await directory(t);
  const store = new UploadStore(data, 60_000, 5);
  const bytes = Buffer.from('123456');
  await assert.rejects(() => store.create('device_upload_test_1', sha256Bytes(bytes), bytes.length, 4), /quota/);
});

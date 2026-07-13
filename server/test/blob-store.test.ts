import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256Bytes, sha256Text } from '@webobsidian/sync-core';
import { MergeBaseStore } from '../src/sync/base-store.js';
import { BlobStore } from '../src/sync/blob-store.js';

async function dataDir(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-blobs-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function read(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('blob store streams, verifies, deduplicates and serves exact ranges', async (t) => {
  const data = await dataDir(t);
  const bytes = Buffer.from('0123456789');
  const hash = sha256Bytes(bytes);
  const store = new BlobStore(data);
  async function* chunks() { yield bytes.subarray(0, 3); yield bytes.subarray(3, 7); yield bytes.subarray(7); }
  const first = await store.put(chunks(), hash, bytes.length);
  const second = await store.put(chunks(), hash, bytes.length);
  assert.equal(second.file, first.file);
  assert.equal((await fs.stat(first.file)).mode & 0o777, 0o600);
  const range = await store.range(hash, 2, 6);
  assert.equal(range.length, 5);
  assert.equal((await read(range.stream)).toString(), '23456');
});

test('blob store removes partial data after hash/size failure and supports empty blobs', async (t) => {
  const data = await dataDir(t);
  const store = new BlobStore(data, 10);
  await assert.rejects(() => store.put([Buffer.from('wrong')], sha256Text('right'), 5), /hash mismatch/);
  await assert.rejects(() => store.put([Buffer.alloc(11)], sha256Bytes(Buffer.alloc(11)), 11), /exceeds limit/);
  const emptyHash = sha256Bytes(new Uint8Array());
  await store.put([], emptyHash, 0);
  const range = await store.range(emptyHash);
  assert.equal((await read(range.stream)).length, 0);
  assert.deepEqual((await fs.readdir(path.join(data, 'sync', 'uploads'))).filter((name) => name.endsWith('.tmp')), []);
});

test('merge base retention honors age, count and protected references', async (t) => {
  const data = await dataDir(t);
  const store = new MergeBaseStore(data);
  const values = ['one', 'two', 'three'];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    await store.retain({
      entryId: 'entry_base_retention', revision: index + 1,
      hash: sha256Text(value), size: value.length, eventSequence: index + 1,
    }, [Buffer.from(value)]);
  }
  const protectedHash = sha256Text('one');
  const result = await store.prune({ maxAgeMs: Number.MAX_SAFE_INTEGER, maxPerEntry: 1, protectedHashes: new Set([protectedHash]) });
  assert.deepEqual(result.removed.map((base) => base.revision), [2]);
  assert.deepEqual((await store.list()).map((base) => base.revision).sort(), [1, 3]);
  assert.equal((await store.get('entry_base_retention', 1))?.hash, protectedHash);
});

test('blob garbage collection removes only old unreferenced content', async (t) => {
  const data = await dataDir(t);
  const store = new BlobStore(data);
  const keptHash = sha256Text('keep');
  const removedHash = sha256Text('remove');
  await store.put([Buffer.from('keep')], keptHash, 4);
  await store.put([Buffer.from('remove')], removedHash, 6);
  const old = new Date('2020-01-01T00:00:00Z');
  await fs.utimes(store.file(removedHash), old, old);
  assert.deepEqual(await store.removeUnreferenced(new Set([keptHash]), new Date('2021-01-01T00:00:00Z')), [removedHash]);
  assert.ok(await store.get(keptHash));
  assert.equal(await store.get(removedHash), null);
});

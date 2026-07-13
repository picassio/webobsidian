import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { sha256Text } from '@picassio/sync-core';
import { BlobStore } from '../src/sync/blob-store.js';
import { SyncCoordinator } from '../src/sync/coordinator.js';
import { SyncDoctor } from '../src/sync/doctor.js';

async function setup(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-doctor-vault-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-doctor-data-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]));
  const coordinator = new SyncCoordinator({ vaultRoot: root, dataDir: data });
  await coordinator.initialize();
  await coordinator.apply({
    operation: 'create', clientSequence: 1, idempotencyKey: 'device:doctor:create:1',
    path: 'A.md', kind: 'file', content: { hash: sha256Text('a'), size: 1, inlineText: 'a' },
  }, { type: 'device', id: 'device_doctor_0001' });
  return { root, data };
}

test('sync doctor validates healthy journal, projections and filesystem', async (t) => {
  const { root, data } = await setup(t);
  const report = await new SyncDoctor(data, root).run();
  assert.equal(report.healthy, true);
  assert.equal(report.readOnlyRecommended, false);
  assert.equal(report.latestSequence, 1);
  assert.equal(report.checkedEntries, 1);
  assert.deepEqual(report.issues, []);
});

test('sync doctor detects filesystem and journal corruption without repairing history', async (t) => {
  const { root, data } = await setup(t);
  await fs.writeFile(path.join(root, 'A.md'), 'changed-outside');
  let report = await new SyncDoctor(data, root).run({ repair: true });
  assert.equal(report.readOnlyRecommended, true);
  assert.equal(report.issues.some((item) => item.code === 'filesystem_divergence' && !item.repaired), true);

  const segment = path.join(data, 'sync', 'journal', '00000001.json');
  const body = JSON.parse(await fs.readFile(segment, 'utf8')) as { payload: { lastSequence: number } };
  body.payload.lastSequence = 50;
  await fs.writeFile(segment, JSON.stringify(body));
  report = await new SyncDoctor(data, root).run({ repair: true });
  assert.equal(report.issues.some((item) => item.code === 'journal_corrupt' && !item.repairable), true);
});

test('sync doctor optionally removes only expired uploads and old orphan blobs', async (t) => {
  const { root, data } = await setup(t);
  const upload = path.join(data, 'sync', 'uploads', 'expired.part');
  await fs.writeFile(upload, 'partial');
  const blobs = new BlobStore(data);
  const hash = sha256Text('orphan');
  await blobs.put([Buffer.from('orphan')], hash, 6);
  const old = new Date('2020-01-01T00:00:00Z');
  await fs.utimes(upload, old, old);
  await fs.utimes(blobs.file(hash), old, old);
  const report = await new SyncDoctor(data, root).run({
    repair: true, now: new Date('2026-01-01T00:00:00Z'), uploadExpiryMs: 1, orphanGraceMs: 1,
  });
  assert.equal(report.issues.filter((item) => item.repaired).length, 2);
  assert.equal(await fs.stat(upload).catch(() => null), null);
  assert.equal(await blobs.get(hash), null);
  assert.equal(report.readOnlyRecommended, false);
});

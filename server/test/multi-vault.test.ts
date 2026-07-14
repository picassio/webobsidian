import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256Text, type SyncOperation } from '@picassio/sync-core';

function createOperation(content: string, pathValue = 'same.md', sequence = 1): SyncOperation {
  return {
    operation: 'create', clientSequence: sequence, idempotencyKey: `create:${sequence}:${sha256Text(content)}`,
    path: pathValue, kind: 'file',
    content: { hash: sha256Text(content), size: Buffer.byteLength(content), inlineText: content },
  };
}

test('two vault runtimes isolate files, sequences, devices and manifest cursors', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-multi-vault-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  process.env.DATA_DIR = path.join(base, 'data');
  const rootA = path.join(base, 'a');
  const rootB = path.join(base, 'b');
  await Promise.all([fs.mkdir(rootA), fs.mkdir(rootB)]);

  const {
    initializeSyncRuntimes, getSyncRuntime, authenticateSyncToken, shutdownSyncRuntime, leaseSyncRuntime,
    beginSyncRuntimeDrain, cancelSyncRuntimeDrain, waitForSyncRuntimeDrain,
  } = await import('../src/services/sync-runtime.js');
  const { runInVault } = await import('../src/services/vault-context.js');
  const { getVaultRoot } = await import('../src/services/vault.js');
  const { ManifestSnapshotStore, ManifestExpiredError } = await import('../src/sync/manifest-snapshots.js');
  const { SyncDoctor } = await import('../src/sync/doctor.js');
  t.after(() => shutdownSyncRuntime());

  const records = [
    { id: 'vault_test_A_123456789', name: 'A', storage: 'legacy' as const, path: rootA, allowedRoots: [base], trash: '.trash', deleteMode: 'trash' as const, attachmentDir: 'attachments', sync: { enabled: true, bootstrapState: 'ready' as const }, git: { enabled: false, mode: 'backup-only' as const, remote: '', branch: 'main', token: '', authorName: 'WebObsidian', authorEmail: 'webobsidian@localhost', autoSync: false, autoCommitOnSave: false, intervalSec: 300, lfsPatterns: [] }, plugins: { enabled: [], installed: [] } },
    { id: 'vault_test_B_123456789', name: 'B', storage: 'isolated' as const, path: rootB, allowedRoots: [base], trash: '.trash', deleteMode: 'trash' as const, attachmentDir: 'attachments', sync: { enabled: true, bootstrapState: 'ready' as const }, git: { enabled: false, mode: 'backup-only' as const, remote: '', branch: 'main', token: '', authorName: 'WebObsidian', authorEmail: 'webobsidian@localhost', autoSync: false, autoCommitOnSave: false, intervalSec: 300, lfsPatterns: [] }, plugins: { enabled: [], installed: [] } },
  ];
  const runtimes = await initializeSyncRuntimes(records, records[0].id);
  assert.equal(runtimes.length, 2);
  const runtimeA = getSyncRuntime(records[0].id);
  const runtimeB = getSyncRuntime(records[1].id);
  const concurrentRoots = await Promise.all([
    runInVault(runtimeA.context, async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return getVaultRoot(); }),
    runInVault(runtimeB.context, async () => { await new Promise((resolve) => setTimeout(resolve, 1)); return getVaultRoot(); }),
  ]);
  assert.deepEqual(concurrentRoots, [rootA, rootB]);

  await runInVault(runtimeA.context, () => runtimeA.coordinator.apply(createOperation('alpha'), { type: 'device', id: 'device_same_123456789' }));
  await runInVault(runtimeB.context, () => runtimeB.coordinator.apply(createOperation('bravo'), { type: 'device', id: 'device_same_123456789' }));
  assert.equal(await fs.readFile(path.join(rootA, 'same.md'), 'utf8'), 'alpha');
  assert.equal(await fs.readFile(path.join(rootB, 'same.md'), 'utf8'), 'bravo');
  assert.equal((await runtimeA.coordinator.protocolState()).latestSequence, 1);
  assert.equal((await runtimeB.coordinator.protocolState()).latestSequence, 1);

  const codeA = await runtimeA.devices.createPairingCode('A device');
  const pairedA = await runtimeA.devices.pair(codeA.code, 'device_same_123456789', 'A device');
  const authenticated = await authenticateSyncToken(pairedA.token);
  assert.equal(authenticated.runtime?.context.vaultId, records[0].id);
  assert.equal(await runtimeB.devices.authenticate(pairedA.token), null);

  await runInVault(runtimeA.context, () => runtimeA.coordinator.apply(createOperation('second', 'second.md', 2), { type: 'device', id: 'device_same_123456789' }));
  const snapshots = new ManifestSnapshotStore();
  const captured = await runtimeA.coordinator.captureManifest();
  const first = snapshots.create(captured.entries, captured.sequence, 1, records[0].id);
  if (first.nextCursor) {
    assert.throws(() => snapshots.page(first.nextCursor!, 1, records[1].id), ManifestExpiredError);
  }
  const [doctorA, doctorB] = await Promise.all([
    new SyncDoctor(runtimeA.context.dataDir, rootA).run(),
    new SyncDoctor(runtimeB.context.dataDir, rootB).run(),
  ]);
  assert.equal(doctorA.issues.length, 0);
  assert.equal(doctorB.issues.length, 0);
  assert.notEqual(doctorA.checkedEntries, doctorB.checkedEntries);

  const release = leaseSyncRuntime(runtimeA);
  assert.ok(release);
  beginSyncRuntimeDrain(records[0].id);
  assert.equal(leaseSyncRuntime(runtimeA), null);
  let drained = false;
  const waiting = waitForSyncRuntimeDrain(records[0].id, 1_000).then(() => { drained = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(drained, false);
  release();
  await waiting;
  assert.equal(drained, true);
  cancelSyncRuntimeDrain(records[0].id);
});

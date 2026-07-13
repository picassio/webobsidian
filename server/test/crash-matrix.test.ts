import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256Text } from '@webobsidian/sync-core';
import {
  SimulatedProcessCrash,
  SyncCoordinator,
  type CoordinatorCrashPoint,
} from '../src/sync/coordinator.js';
import { JournalStore } from '../src/sync/journal.js';

const points: CoordinatorCrashPoint[] = [
  'after_intent',
  'after_materialize',
  'after_materialized_marker',
  'after_journal_commit',
  'after_revision_snapshot',
  'after_idempotency_snapshot',
];

for (const point of points) {
  test(`hard-crash recovery is deterministic at ${point}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `webobsidian-crash-${point}-`));
    const data = await fs.mkdtemp(path.join(os.tmpdir(), `webobsidian-crash-data-${point}-`));
    t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]));
    const crashed = new SyncCoordinator({
      vaultRoot: root,
      dataDir: data,
      faultInjector(injected) { if (injected === point) throw new SimulatedProcessCrash(point); },
    });
    await crashed.initialize();
    const operation = {
      operation: 'create' as const,
      clientSequence: 1,
      idempotencyKey: `device:crash:${point}:1`,
      path: 'Crash.md',
      kind: 'file' as const,
      content: { hash: sha256Text('safe'), size: 4, inlineText: 'safe' },
    };
    await assert.rejects(() => crashed.apply(operation, { type: 'device', id: 'device_crash_matrix_1' }), SimulatedProcessCrash);

    const recovered = new SyncCoordinator({ vaultRoot: root, dataDir: data });
    await recovered.initialize();
    assert.equal(recovered.health().readOnly, false);
    const shouldCommit = point !== 'after_intent';
    assert.equal(await new JournalStore(data).latestSequence(), shouldCommit ? 1 : 0);
    assert.equal(await fs.readFile(path.join(root, 'Crash.md'), 'utf8').catch(() => null), shouldCommit ? 'safe' : null);
    assert.deepEqual(await fs.readdir(path.join(data, 'sync', 'transactions')), []);
    if (shouldCommit) {
      const retried = await recovered.apply(operation, { type: 'device', id: 'device_crash_matrix_1' });
      assert.equal(retried.sequence, 1);
      assert.equal(await new JournalStore(data).latestSequence(), 1);
    }
  });
}

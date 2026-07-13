import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256Text } from '@webobsidian/sync-core';
import { SyncCoordinator, type CoordinatorCrashPoint } from '../src/sync/coordinator.js';
import { JournalStore } from '../src/sync/journal.js';

function diskFull(): NodeJS.ErrnoException { const error = new Error('simulated disk full') as NodeJS.ErrnoException; error.code = 'ENOSPC'; return error; }

for (const point of ['after_intent', 'after_materialize', 'after_materialized_marker', 'after_journal_commit'] as CoordinatorCrashPoint[]) {
  test(`ENOSPC at ${point} never leaves an ambiguous accepted write`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `webobsidian-enospc-${point}-`));
    const data = await fs.mkdtemp(path.join(os.tmpdir(), `webobsidian-enospc-data-${point}-`));
    t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]));
    let injected = false;
    const coordinator = new SyncCoordinator({ vaultRoot: root, dataDir: data, faultInjector(at) {
      if (!injected && at === point) { injected = true; throw diskFull(); }
    } });
    await coordinator.initialize();
    const operation = {
      operation: 'create' as const, path: 'Disk.md', kind: 'file' as const, clientSequence: 1,
      idempotencyKey: `device:enospc:${point}:0001`, content: { hash: sha256Text('safe'), size: 4, inlineText: 'safe' },
    };
    if (point === 'after_journal_commit') {
      const result = await coordinator.apply(operation, { type: 'device', id: 'device_enospc_test_1' });
      assert.equal(result.status, 'accepted');
      assert.equal(await new JournalStore(data).latestSequence(), 1);
      assert.equal(await fs.readFile(path.join(root, 'Disk.md'), 'utf8'), 'safe');
      assert.equal(coordinator.health().readOnly, false);
    } else {
      await assert.rejects(() => coordinator.apply(operation, { type: 'device', id: 'device_enospc_test_1' }), /disk full/);
      assert.equal(await new JournalStore(data).latestSequence(), 0);
      assert.equal(await fs.stat(path.join(root, 'Disk.md')).catch(() => null), null);
      assert.equal(coordinator.health().readOnly, false);
      const retry = await coordinator.apply(operation, { type: 'device', id: 'device_enospc_test_1' });
      assert.equal(retry.status, 'accepted');
    }
  });
}

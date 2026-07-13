import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acknowledgeApplied,
  assertNoCaseFoldCollision,
  commitLocalApply,
  conflictCopyPath,
  createClientSyncState,
  enqueueOperation,
  evaluatePathPolicy,
  markLocalMaterialized,
  mergeText,
  prepareLocalApply,
  sha256Chunks,
  sha256Text,
  timingSafeHexEqual,
  type SyncEvent,
} from '../src/index.js';

test('server path policy excludes internal, editor, and OS paths', () => {
  for (const path of ['.git/config', '.obsidian/workspace.json', 'Folder/.trash/a.md', 'node_modules/x', '.DS_Store', 'a.swp', 'a.tmp-12']) {
    assert.equal(evaluatePathPolicy(path).allowed, false, path);
  }
  assert.deepEqual(evaluatePathPolicy('Notes/Café.md'), {
    allowed: true,
    path: 'Notes/Café.md',
    folded: 'notes/café.md',
  });
  assert.throws(() => assertNoCaseFoldCollision(['A.md', 'a.md']), /collision/);
});

test('hash helpers are deterministic, streaming, and compare without early return', async () => {
  const expected = sha256Text('hello world');
  const streamed = await sha256Chunks([new TextEncoder().encode('hello '), new TextEncoder().encode('world')]);
  assert.equal(streamed, expected);
  assert.equal(timingSafeHexEqual(expected, streamed), true);
  assert.equal(timingSafeHexEqual(expected, '0'.repeat(64)), false);
  assert.equal(timingSafeHexEqual(expected, 'bad'), false);
});

test('diff3 cleanly merges independent lines and rejects overlap', () => {
  const base = 'one\ntwo\nthree\n';
  const clean = mergeText('ONE\ntwo\nthree\n', base, 'one\ntwo\nTHREE\n');
  assert.deepEqual(clean, { clean: true, content: 'ONE\ntwo\nTHREE\n' });
  const conflict = mergeText('ONE\ntwo\nthree\n', base, 'UN\ntwo\nthree\n');
  assert.deepEqual(conflict, { clean: false, reason: 'overlap' });
  assert.deepEqual(mergeText('x', null, 'y'), { clean: false, reason: 'base_unavailable' });
});

test('conflict-copy names are normalized, sanitized, UTC, and ordinal-safe', () => {
  const path = conflictCopyPath('Notes/A.md', 'phone/bad', new Date('2026-07-12T01:02:03.004Z'), 2);
  assert.equal(path, 'Notes/A (conflict from phone-bad 2026-07-12T01-02-03-004Z 2).md');
});

test('client state never acknowledges before durable local application', () => {
  let state = createClientSyncState('vault_example_0001', 'device_alpha_0001');
  state = enqueueOperation(state, {
    operation: 'mkdir',
    clientSequence: 1,
    idempotencyKey: 'device_alpha_0001:1:mkdir',
    path: 'Folder',
    kind: 'directory',
  });
  assert.equal(state.nextClientSequence, 2);
  assert.throws(() => acknowledgeApplied(state, 1), /unapplied/);
  const event: SyncEvent = {
    sequence: 1,
    eventId: 'event_example_0001',
    actor: { type: 'device', id: 'device_alpha_0001' },
    operation: 'mkdir',
    entryId: 'directory_entry_01',
    path: 'Folder',
    baseRevision: null,
    revision: 1,
    hash: null,
    size: 0,
    occurredAt: '2026-07-12T00:00:00.000Z',
  };
  state = prepareLocalApply(state, event);
  assert.throws(() => commitLocalApply(state), /materialized/);
  state = markLocalMaterialized(state);
  state = commitLocalApply(state);
  state = acknowledgeApplied(state, 1);
  assert.equal(state.lastAppliedSequence, 1);
  assert.equal(state.lastAcknowledgedSequence, 1);
  assert.equal(state.applyIntent, null);
});

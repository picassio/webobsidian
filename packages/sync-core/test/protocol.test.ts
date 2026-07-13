import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ChangesResponseSchema,
  ErrorEnvelopeSchema,
  HandshakeRequestSchema,
  HandshakeResponseSchema,
  ManifestPageSchema,
  ModifyOperationSchema,
  OperationsRequestSchema,
  OperationsResponseSchema,
  SyncEventSchema,
  VaultPathSchema,
  applyEvent,
  createReplayState,
  replayEvents,
  SequenceGapError,
} from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(path.join(root, 'fixtures/protocol-v1.json'), 'utf8')) as Record<string, unknown>;

test('golden protocol fixtures conform to runtime schemas', () => {
  HandshakeRequestSchema.parse(fixture.handshakeRequest);
  HandshakeResponseSchema.parse(fixture.handshakeResponse);
  ManifestPageSchema.parse(fixture.manifestPage);
  ChangesResponseSchema.parse(fixture.changesResponse);
  OperationsRequestSchema.parse(fixture.operationsRequest);
  OperationsResponseSchema.parse(fixture.operationsResponse);
  ErrorEnvelopeSchema.parse(fixture.errorEnvelope);
});

test('vault paths reject traversal, absolute, backslash, empty segments and non-NFC', () => {
  for (const invalid of ['../secret.md', '/root.md', 'a\\b.md', 'a//b.md', 'a/./b.md', 'Cafe\u0301.md']) {
    assert.equal(VaultPathSchema.safeParse(invalid).success, false, invalid);
  }
  assert.equal(VaultPathSchema.parse('Café/Note.md'), 'Café/Note.md');
});

test('content reference accepts empty text and enforces UTF-8 byte limit', () => {
  const base = {
    operation: 'modify' as const,
    clientSequence: 1,
    idempotencyKey: 'device_alpha_0001:1:bytes',
    entryId: 'entry_notes_00001',
    baseRevision: 1,
  };
  assert.equal(ModifyOperationSchema.safeParse({ ...base, content: { hash: 'a'.repeat(64), size: 0, inlineText: '' } }).success, true);
  const oversized = 'é'.repeat(600_000); // 1.2 MB UTF-8, fewer than 1,048,576 JS characters.
  assert.equal(ModifyOperationSchema.safeParse({ ...base, content: { hash: 'a'.repeat(64), size: 1_200_000, inlineText: oversized } }).success, false);
});

test('change feed requires contiguous sequences', () => {
  const changes = structuredClone(fixture.changesResponse) as { events: Array<{ sequence: number }> };
  changes.events[1]!.sequence = 99;
  assert.equal(ChangesResponseSchema.safeParse(changes).success, false);
});

test('event replay preserves identity through rename and creates a tombstone', () => {
  const manifest = ManifestPageSchema.parse(fixture.manifestPage);
  const changes = ChangesResponseSchema.parse(fixture.changesResponse);
  const final = replayEvents(createReplayState(manifest.entries, manifest.snapshotSequence), changes.events);
  assert.equal(final.sequence, 43);
  const entry = final.entries.get('entry_notes_00001');
  assert.ok(entry);
  assert.equal(entry.path, 'Notes/Start.md');
  assert.equal(entry.revision, 4);
  assert.equal(entry.deleted, true);
  assert.equal(entry.hash, null);
});

test('event replay rejects sequence gaps', () => {
  const event = SyncEventSchema.parse((fixture.changesResponse as { events: unknown[] }).events[0]);
  assert.throws(() => applyEvent(createReplayState([], 0), event), SequenceGapError);
});

test('directory rename rewrites live descendant paths', () => {
  const at = '2026-07-12T00:00:00.000Z';
  const initial = createReplayState([
    { entryId: 'directory_entry_01', path: 'Old', kind: 'directory', revision: 1, hash: null, size: 0, modifiedAt: at, deleted: false, sequence: 1 },
    { entryId: 'child_file_entry1', path: 'Old/Child.md', kind: 'file', revision: 1, hash: 'a'.repeat(64), size: 1, modifiedAt: at, deleted: false, sequence: 1 },
  ], 1);
  const renamed = applyEvent(initial, {
    sequence: 2,
    eventId: 'rename_event_0002',
    actor: { type: 'web', id: 'browser_00000001' },
    operation: 'rename',
    entryId: 'directory_entry_01',
    path: 'New',
    oldPath: 'Old',
    baseRevision: 1,
    revision: 2,
    hash: null,
    size: 0,
    occurredAt: '2026-07-12T00:00:01.000Z',
  });
  assert.equal(renamed.entries.get('child_file_entry1')?.path, 'New/Child.md');
});

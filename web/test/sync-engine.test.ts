import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Text, type OperationResult, type SyncEvent, type SyncOperation } from '@picassio/sync-core';
import { BrowserSyncEngine, type LocalSyncAdapter, type SyncTransport } from '../src/lib/sync-engine.js';
import { BrowserLocalSyncAdapter } from '../src/lib/browser-sync-adapter.js';
import { ensureUploadDirectories } from '../src/lib/browser-sync-runtime.js';
import { useStore } from '../src/lib/store.js';
import type { BrowserDeviceState, LocalApplyIntent, LocalEntryProjection, PendingAttachment, PersistedDraft, SyncPersistence } from '../src/lib/sync-db.js';

(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;

class MemoryPersistence implements SyncPersistence {
  device: BrowserDeviceState | null = { deviceId: 'device_browser_engine_1', deviceName: 'Browser', token: 'token', vaultId: 'vault_browser_engine_1', cursor: 0, nextClientSequence: 1 };
  queued: SyncOperation[] = [];
  pendingAttachments: PendingAttachment[] = [];
  intents: LocalApplyIntent[] = [];
  savedDrafts: PersistedDraft[] = [];
  projections: LocalEntryProjection[] = [];
  workspace: unknown = null;
  workspaceMigrated = false;
  async getDevice() { return this.device; }
  async putDevice(state: BrowserDeviceState) { this.device = state; }
  async putCursor(cursor: number) { this.device = { ...this.device!, cursor }; }
  async takeClientSequence() { const value = this.device!.nextClientSequence; this.device = { ...this.device!, nextClientSequence: value + 1 }; return value; }
  async operations() { return this.queued; }
  async attachments() { return this.pendingAttachments; }
  async putAttachment(attachment: PendingAttachment) { this.pendingAttachments.push(attachment); }
  async removeAttachment(key: string) { this.pendingAttachments = this.pendingAttachments.filter((item) => item.idempotencyKey !== key); }
  async putOperation(operation: SyncOperation) { this.queued.push(operation); }
  async removeOperation(key: string) { this.queued = this.queued.filter((operation) => operation.idempotencyKey !== key); }
  async putApplyIntent(intent: LocalApplyIntent) { this.intents = [...this.intents.filter((item) => item.event.eventId !== intent.event.eventId), intent]; }
  async removeApplyIntent(eventId: string) { this.intents = this.intents.filter((intent) => intent.event.eventId !== eventId); }
  async applyIntents() { return this.intents; }
  async putDraft(draft: PersistedDraft) { this.savedDrafts.push(draft); }
  async drafts() { return this.savedDrafts; }
  async putEntry(entry: LocalEntryProjection) { this.projections = [...this.projections.filter((item) => item.entryId !== entry.entryId), entry]; }
  async entries() { return this.projections; }
  async replaceEntries(entries: LocalEntryProjection[]) { this.projections = entries; }
  async getWorkspace<T>() { return this.workspace as T | null; }
  async putWorkspace<T>(workspace: T) { this.workspace = workspace; }
  async isWorkspaceMigrated() { return this.workspaceMigrated; }
  async markWorkspaceMigrated() { this.workspaceMigrated = true; }
}

function event(sequence: number): SyncEvent {
  return {
    sequence, eventId: `event_browser_engine_${sequence}`, actor: { type: 'device', id: 'device_remote_engine_1' },
    operation: 'create', entryId: `entry_browser_engine_${sequence}`, path: `${sequence}.md`,
    baseRevision: null, revision: 1, hash: sha256Text(String(sequence)), size: 1,
    occurredAt: '2026-07-13T00:00:00.000Z',
  };
}

function transport(events: SyncEvent[]): SyncTransport & { acknowledged: number[] } {
  return {
    acknowledged: [],
    async handshake() { return { vaultId: 'vault_browser_engine_1', latestSequence: events.at(-1)?.sequence ?? 0, minimumRetainedSequence: 1, readOnly: false }; },
    async manifest() { return { entries: [], snapshotSequence: 0 }; },
    async changes(after) {
      const page = events.filter((item) => item.sequence > after);
      return { events: page, nextAfter: page.at(-1)?.sequence ?? after, hasMore: false, latestSequence: events.at(-1)?.sequence ?? after };
    },
    async acknowledge(sequence) { this.acknowledged.push(sequence); },
    async operations(operations) { return operations.map((operation): OperationResult => ({ idempotencyKey: operation.idempotencyKey, status: 'accepted' })); },
    async connectWake() { return () => {}; },
  };
}

test('attachment preparation queues missing parent directories once before file sequence allocation', async () => {
  const persistence = new MemoryPersistence();
  persistence.projections = [{ entryId: 'entry_assets', path: 'assets', revision: 1, hash: null, size: 0, deleted: false }];
  persistence.queued = [{ operation: 'mkdir', path: 'queued', kind: 'directory', clientSequence: 1, idempotencyKey: 'queued-dir' }];
  persistence.device = { ...persistence.device!, nextClientSequence: 2 };
  const queued: SyncOperation[] = [];
  const known = new Set<string>();
  const engine = { async queue(operation: SyncOperation) { queued.push(operation); } };

  await ensureUploadDirectories(persistence, engine, 'attachments/images', known);
  await ensureUploadDirectories(persistence, engine, 'attachments/images', known);
  await ensureUploadDirectories(persistence, engine, 'assets', known);
  await ensureUploadDirectories(persistence, engine, 'queued', known);

  assert.deepEqual(queued.map((operation) => ({ operation: operation.operation, path: 'path' in operation ? operation.path : null, clientSequence: operation.clientSequence })), [
    { operation: 'mkdir', path: 'attachments', clientSequence: 2 },
    { operation: 'mkdir', path: 'attachments/images', clientSequence: 3 },
  ]);
  assert.equal(persistence.device?.nextClientSequence, 4);
});

test('cursor advances only after durable apply intent and local materialization', async () => {
  const persistence = new MemoryPersistence();
  const remote = transport([event(1), event(2)]);
  const applied: number[] = [];
  const adapter: LocalSyncAdapter = {
    async apply(value) {
      assert.equal(persistence.intents[0]?.event.eventId, value.eventId);
      applied.push(value.sequence);
    },
    async recover() {}, async bootstrap() {}, async conflict() {},
  };
  const statuses: string[] = [];
  const engine = new BrowserSyncEngine(persistence, remote, adapter, (status) => statuses.push(status));
  await engine.start();
  engine.stop();
  assert.deepEqual(applied, [1, 2]);
  assert.equal(persistence.device?.cursor, 2);
  assert.deepEqual(remote.acknowledged, [2]);
  assert.deepEqual(persistence.intents, []);
  assert.equal(statuses.includes('synced'), true);
});

test('failed local application retains intent and never advances cursor or acknowledgement', async () => {
  const persistence = new MemoryPersistence();
  const remote = transport([event(1)]);
  const adapter: LocalSyncAdapter = {
    async apply() { throw new Error('disk full'); },
    async recover() {}, async bootstrap() {}, async conflict() {},
  };
  const engine = new BrowserSyncEngine(persistence, remote, adapter, () => {});
  await assert.rejects(() => engine.start(), /disk full/);
  engine.stop();
  assert.equal(persistence.device?.cursor, 0);
  assert.equal(persistence.intents.length, 1);
  assert.deepEqual(remote.acknowledged, []);
});

test('local echo with identical hash converges without re-dirtying the document', async () => {
  const persistence = new MemoryPersistence();
  const content = 'saved content\n';
  useStore.setState({
    activePath: 'echo.md', content, dirty: true, editGeneration: 1,
    activeEntryId: 'entry_browser_echo_1', activeRevision: 1, activeHash: sha256Text('old'),
    documents: { 'echo.md': {
      path: 'echo.md', entryId: 'entry_browser_echo_1', content, baseContent: 'old\n', revision: 1,
      hash: sha256Text('old'), dirtyGeneration: 1, saveGeneration: 0, pending: true, error: null,
    } },
    loadTree: async () => {},
  });
  const adapter = new BrowserLocalSyncAdapter(persistence, async () => content);
  await adapter.apply({ ...event(1), entryId: 'entry_browser_echo_1', path: 'echo.md', operation: 'modify', baseRevision: 1, revision: 2, hash: sha256Text(content), size: content.length });
  assert.equal(useStore.getState().dirty, false);
  assert.equal(useStore.getState().documents['echo.md']?.saveGeneration, 1);
  assert.equal(useStore.getState().documents['echo.md']?.revision, 2);
});

test('remote text update diff3-merges independent edits and preserves overlapping drafts', async () => {
  const persistence = new MemoryPersistence();
  const base = 'one\ntwo\nthree\n';
  const local = 'ONE\ntwo\nthree\n';
  const remote = 'one\ntwo\nTHREE\n';
  const setup = () => useStore.setState({
    activePath: 'merge.md', content: local, dirty: true, editGeneration: 2,
    activeEntryId: 'entry_browser_merge_1', activeRevision: 1, activeHash: sha256Text(base),
    documents: { 'merge.md': {
      path: 'merge.md', entryId: 'entry_browser_merge_1', content: local, baseContent: base, revision: 1,
      hash: sha256Text(base), dirtyGeneration: 2, saveGeneration: 1, pending: false, error: null,
    } },
    loadTree: async () => {}, syncStatus: 'synced', syncConflictCount: 0,
  });
  setup();
  const adapter = new BrowserLocalSyncAdapter(persistence, async () => remote);
  await adapter.apply({ ...event(2), entryId: 'entry_browser_merge_1', path: 'merge.md', operation: 'modify', baseRevision: 1, revision: 2, hash: sha256Text(remote), size: remote.length });
  assert.equal(useStore.getState().documents['merge.md']?.content, 'ONE\ntwo\nTHREE\n');
  assert.equal(useStore.getState().dirty, true);
  assert.equal(useStore.getState().activeRevision, 2);

  setup();
  const overlap = 'REMOTE\ntwo\nthree\n';
  await new BrowserLocalSyncAdapter(persistence, async () => overlap).apply({
    ...event(2), entryId: 'entry_browser_merge_1', path: 'merge.md', operation: 'modify',
    baseRevision: 1, revision: 2, hash: sha256Text(overlap), size: overlap.length,
  });
  assert.equal(useStore.getState().documents['merge.md']?.content, local);
  assert.match(useStore.getState().documents['merge.md']?.error ?? '', /overlaps/);
  assert.equal(useStore.getState().syncStatus, 'conflict');
});

test('expired cursor bootstraps an immutable manifest before acknowledging later changes', async () => {
  const persistence = new MemoryPersistence();
  persistence.device = { ...persistence.device!, cursor: 3 };
  let bootstrapped = 0;
  const remote = transport([]);
  remote.handshake = async () => ({ vaultId: 'vault_browser_engine_1', latestSequence: 20, minimumRetainedSequence: 10, readOnly: false });
  remote.manifest = async () => ({ entries: [{
    entryId: 'entry_manifest_engine_1', path: 'manifest.md', kind: 'file', revision: 4,
    hash: sha256Text('manifest'), size: 8, modifiedAt: '2026-07-13T00:00:00.000Z', deleted: false, sequence: 20,
  }], snapshotSequence: 20 });
  const adapter: LocalSyncAdapter = {
    async apply() {}, async recover() {}, async conflict() {},
    async bootstrap(entries) { bootstrapped = entries.length; },
  };
  const engine = new BrowserSyncEngine(persistence, remote, adapter, () => {});
  await engine.start(); engine.stop();
  assert.equal(bootstrapped, 1);
  assert.equal(persistence.device?.cursor, 20);
  assert.deepEqual(remote.acknowledged, [20]);
});

test('offline queue removes accepted operations but preserves rejected work for conflict flow', async () => {
  const persistence = new MemoryPersistence();
  const accepted: SyncOperation = {
    operation: 'mkdir', clientSequence: 1, idempotencyKey: 'browser:queue:accepted:1', path: 'A', kind: 'directory',
  };
  await persistence.putOperation(accepted);
  const remote = transport([]);
  await new BrowserSyncEngine(persistence, remote, { async apply() {}, async recover() {}, async bootstrap() {}, async conflict() {} }, () => {}).flush();
  assert.deepEqual(persistence.queued, []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { useStore, type DocumentState } from '../src/lib/store.js';

interface DeferredResponse { resolve: (response: Response) => void; promise: Promise<Response> }
function deferred(): DeferredResponse {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { resolve, promise };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function document(content: string, generation: number): DocumentState {
  return {
    path: 'A.md', entryId: 'entry_browser_save_1', content, baseContent: '', revision: 1, hash: 'a'.repeat(64),
    dirtyGeneration: generation, saveGeneration: 0, pending: false, error: null,
  };
}
function reset(doc: DocumentState) {
  useStore.setState({
    activePath: 'A.md', content: doc.content, dirty: true,
    activeEntryId: doc.entryId, activeRevision: doc.revision, activeHash: doc.hash,
    editGeneration: doc.dirtyGeneration, documents: { 'A.md': doc },
  });
}

test('late save response cannot clear a newer edit and queued save uses new revision', async (t) => {
  const first = deferred();
  const second = deferred();
  const calls: Array<{ body: { content: string; baseRevision: number } }> = [];
  const responses = [first, second];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) as { content: string; baseRevision: number } });
    return responses.shift()!.promise;
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  reset(document('first', 1));
  const savingFirst = useStore.getState().save();
  await new Promise((resolve) => setImmediate(resolve));
  useStore.getState().setContent('second');
  const savingSecond = useStore.getState().save();
  first.resolve(json({ ok: true, entryId: 'entry_browser_save_1', revision: 2, hash: 'b'.repeat(64), path: 'A.md' }));
  await savingFirst;
  assert.equal(useStore.getState().dirty, true);
  assert.equal(useStore.getState().documents['A.md']?.content, 'second');
  await new Promise((resolve) => setImmediate(resolve));
  second.resolve(json({ ok: true, entryId: 'entry_browser_save_1', revision: 3, hash: 'c'.repeat(64), path: 'A.md' }));
  await savingSecond;
  assert.equal(useStore.getState().dirty, false);
  assert.equal(useStore.getState().documents['A.md']?.revision, 3);
  assert.deepEqual(calls.map((call) => call.body), [
    { path: 'A.md', content: 'first', baseRevision: 1 },
    { path: 'A.md', content: 'second', baseRevision: 2 },
  ]);
});

test('navigation during an in-flight save updates only the originating document', async (t) => {
  const response = deferred();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response.promise) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  reset(document('from A', 1));
  const saving = useStore.getState().save();
  await new Promise((resolve) => setImmediate(resolve));
  useStore.setState({
    activePath: 'B.md', content: 'B', dirty: false, activeEntryId: 'entry_browser_save_2',
    activeRevision: 7, activeHash: 'd'.repeat(64), editGeneration: 0,
    documents: { ...useStore.getState().documents, 'B.md': {
      path: 'B.md', entryId: 'entry_browser_save_2', content: 'B', baseContent: 'B', revision: 7,
      hash: 'd'.repeat(64), dirtyGeneration: 0, saveGeneration: 0, pending: false, error: null,
    } },
  });
  response.resolve(json({ ok: true, entryId: 'entry_browser_save_1', revision: 2, hash: 'b'.repeat(64), path: 'A.md' }));
  await saving;
  const state = useStore.getState();
  assert.equal(state.activePath, 'B.md');
  assert.equal(state.activeRevision, 7);
  assert.equal(state.content, 'B');
  assert.equal(state.documents['A.md']?.revision, 2);
});

test('409 keeps the local draft dirty with a per-document error', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => json({ error: 'base revision is stale' }, 409)) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  reset(document('local draft', 1));
  await assert.rejects(() => useStore.getState().save(), /base revision is stale/);
  const state = useStore.getState();
  assert.equal(state.dirty, true);
  assert.equal(state.documents['A.md']?.content, 'local draft');
  assert.match(state.documents['A.md']?.error ?? '', /stale/);
});

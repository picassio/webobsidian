import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { SyncOperation } from '@picassio/sync-core';
import { NodeSyncTransport } from '../src/transport';

const fixture = JSON.parse(await readFile(new URL('../../../packages/sync-core/fixtures/protocol-v1.json', import.meta.url), 'utf8')) as Record<string, unknown>;

test('headless transport consumes the shared Protocol 1.0 golden transcript with bearer authentication', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input); calls.push({ url, init });
    const payload = url.endsWith('/handshake') ? fixture.handshakeResponse
      : url.includes('/manifest') ? fixture.manifestPage
      : url.includes('/changes') ? fixture.changesResponse
      : url.endsWith('/operations') ? fixture.operationsResponse
      : { protocolVersion: '1.0' };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const transport = new NodeSyncTransport('http://127.0.0.1:8787', 'device-token-conformance');
    const handshake = await transport.handshake({ deviceId: 'device_alpha_0001', deviceName: 'Headless', cursor: 40 });
    const manifest = await transport.manifest();
    const changes = await transport.changes(40, 1000);
    const operation = (fixture.operationsRequest as { operations: SyncOperation[] }).operations[0]!;
    const results = await transport.operations([operation]);
    await transport.acknowledge(43);

    assert.equal(handshake.latestSequence, 43);
    assert.equal(manifest.snapshotSequence, 40);
    assert.deepEqual(changes.events.map((event) => event.sequence), [41, 42, 43]);
    assert.equal(results[0]?.revision, 1);
    assert.ok(calls.every((call) => (call.init.headers as Record<string, string>).authorization === 'Bearer device-token-conformance'));
    assert.equal(JSON.parse(String(calls[0]!.init.body)).protocolVersion, '1.0');
  } finally { globalThis.fetch = originalFetch; }
});

test('headless transport rejects a future protocol response instead of silently accepting it', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ...(fixture.handshakeResponse as object), protocolVersion: '1.1' }), { status: 200 });
  try {
    await assert.rejects(new NodeSyncTransport('http://localhost:8787', 'token').handshake({ deviceId: 'device_alpha_0001', deviceName: 'Headless', cursor: 0 }));
  } finally { globalThis.fetch = originalFetch; }
});

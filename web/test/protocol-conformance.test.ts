import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { SyncOperation } from '@webobsidian/sync-core';
import { HttpSyncTransport } from '../src/lib/sync-engine';

const fixture = JSON.parse(await readFile(new URL('../../packages/sync-core/fixtures/protocol-v1.json', import.meta.url), 'utf8')) as Record<string, unknown>;

test('browser transport consumes the shared Protocol 1.0 golden transcript', async () => {
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
    const transport = new HttpSyncTransport('/api/sync/v1');
    const handshake = await transport.handshake({ deviceId: 'device_alpha_0001', deviceName: 'Browser', cursor: 40 });
    const manifest = await transport.manifest();
    const changes = await transport.changes(40, 1000);
    const operation = (fixture.operationsRequest as { operations: SyncOperation[] }).operations[0]!;
    const results = await transport.operations([operation]);
    await transport.acknowledge(43);

    assert.equal(handshake.latestSequence, 43);
    assert.equal(manifest.entries[0]?.path, 'Notes/Welcome.md');
    assert.deepEqual(changes.events.map((event) => event.operation), ['modify', 'rename', 'delete']);
    assert.equal(results[0]?.status, 'accepted');
    assert.ok(calls.every((call) => call.init.credentials === 'include'));
    assert.equal(JSON.parse(String(calls[0]!.init.body)).protocolVersion, '1.0');
    assert.equal(JSON.parse(String(calls.at(-1)!.init.body)).sequence, 43);
  } finally { globalThis.fetch = originalFetch; }
});

test('browser transport rejects a future protocol response instead of silently accepting it', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ...fixture.handshakeResponse as object, protocolVersion: '1.1' }), { status: 200 });
  try {
    await assert.rejects(new HttpSyncTransport().handshake({ deviceId: 'device_alpha_0001', deviceName: 'Browser', cursor: 0 }));
  } finally { globalThis.fetch = originalFetch; }
});

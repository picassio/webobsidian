import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import test from 'node:test';
import { sha256Text } from '@webobsidian/sync-core';
import { syncRouter } from '../src/routes/sync.js';
import { initializeSyncRuntime, getSyncCoordinator, getSyncDeviceStore } from '../src/services/sync-runtime.js';
import { wsTickets, WsTicketStore } from '../src/sync/ws-tickets.js';

async function post(base: string, route: string, body: unknown, token?: string) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('pair, handshake, ticket, protocol rejection and revocation use canonical contracts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-sync-route-vault-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-sync-route-data-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]));
  process.env.DATA_DIR = data;
  await initializeSyncRuntime(root, data);
  const pairing = await getSyncDeviceStore().createPairingCode('Test');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/sync/v1', syncRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  const pairedResponse = await post(base, '/api/sync/v1/pair', {
    protocolVersion: '1.0', code: pairing.code, deviceId: 'device_route_test_1', deviceName: 'Route Test',
  });
  assert.equal(pairedResponse.status, 201);
  const paired = await pairedResponse.json() as { token: string; vaultId: string; deviceId: string };
  assert.ok(paired.token);
  assert.equal(paired.deviceId, 'device_route_test_1');

  const handshakeResponse = await post(base, '/api/sync/v1/handshake', {
    protocolVersion: '1.0', deviceId: paired.deviceId, capabilities: [],
  }, paired.token);
  assert.equal(handshakeResponse.status, 200);
  const handshake = await handshakeResponse.json() as { vaultId: string; latestSequence: number; limits: { blobChunkBytes: number } };
  assert.equal(handshake.vaultId, paired.vaultId);
  assert.equal(handshake.latestSequence, 0);
  assert.equal(handshake.limits.blobChunkBytes, 8_388_608);

  const incompatible = await post(base, '/api/sync/v1/handshake', { protocolVersion: '2.0', capabilities: [] }, paired.token);
  assert.equal(incompatible.status, 426);
  assert.equal(((await incompatible.json()) as { error: { code: string } }).error.code, 'protocol_incompatible');

  await getSyncCoordinator().apply({
    operation: 'mkdir', clientSequence: 1, idempotencyKey: 'device:route:mkdir:1', path: 'Folder', kind: 'directory',
  }, { type: 'device', id: paired.deviceId });
  const routeFile = await getSyncCoordinator().apply({
    operation: 'create', clientSequence: 2, idempotencyKey: 'device:route:create:2', path: 'Folder/A.md', kind: 'file',
    content: { hash: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb', size: 1, inlineText: 'a' },
  }, { type: 'device', id: paired.deviceId });
  const manifestResponse = await fetch(`${base}/api/sync/v1/manifest?limit=1`, { headers: { authorization: `Bearer ${paired.token}` } });
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json() as { entries: unknown[]; nextCursor: string; snapshotSequence: number };
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.snapshotSequence, 2);
  const nextManifest = await fetch(`${base}/api/sync/v1/manifest?limit=1&cursor=${encodeURIComponent(manifest.nextCursor)}`, { headers: { authorization: `Bearer ${paired.token}` } });
  assert.equal(((await nextManifest.json()) as { entries: unknown[] }).entries.length, 1);

  const changesResponse = await fetch(`${base}/api/sync/v1/changes?after=0&limit=1`, { headers: { authorization: `Bearer ${paired.token}` } });
  const changes = await changesResponse.json() as { events: Array<{ sequence: number }>; hasMore: boolean; nextAfter: number };
  assert.deepEqual(changes.events.map((event) => event.sequence), [1]);
  assert.equal(changes.hasMore, true);
  const ackResponse = await post(base, '/api/sync/v1/ack', { protocolVersion: '1.0', sequence: 2 }, paired.token);
  assert.equal(ackResponse.status, 200);
  assert.equal(((await ackResponse.json()) as { acknowledgedSequence: number }).acknowledgedSequence, 2);

  const batchResponse = await post(base, '/api/sync/v1/operations', {
    protocolVersion: '1.0',
    operations: [
      {
        operation: 'create', clientSequence: 3, idempotencyKey: 'device:route:batch:create:3',
        path: 'Batch.md', kind: 'file', content: { hash: sha256Text('batch'), size: 5, inlineText: 'batch' },
      },
      {
        operation: 'mkdir', clientSequence: 4, idempotencyKey: 'device:route:batch:collision:4',
        path: 'Folder/A.md', kind: 'directory',
      },
      {
        operation: 'mkdir', clientSequence: 5, idempotencyKey: 'device:route:batch:dependent:5',
        dependsOn: ['device:route:batch:collision:4'], path: 'Skipped', kind: 'directory',
      },
      {
        operation: 'mkdir', clientSequence: 6, idempotencyKey: 'device:route:batch:independent:6',
        path: 'Independent', kind: 'directory',
      },
    ],
  }, paired.token);
  assert.equal(batchResponse.status, 200);
  const batch = await batchResponse.json() as { results: Array<{ status: string; errorCode?: string }> };
  assert.deepEqual(batch.results.map((result) => result.status), ['accepted', 'rejected', 'dependency_failed', 'accepted']);
  assert.equal(batch.results[1]?.errorCode, 'path_collision');

  const fileResponse = await fetch(`${base}/api/sync/v1/files/${routeFile.entryId}?revision=1`, {
    headers: { authorization: `Bearer ${paired.token}`, range: 'bytes=0-0' },
  });
  assert.equal(fileResponse.status, 206);
  assert.equal(await fileResponse.text(), 'a');
  assert.equal(fileResponse.headers.get('x-revision'), '1');

  const uploadBytes = new TextEncoder().encode('upload');
  const uploadHash = sha256Text('upload');
  const uploadResponse = await post(base, '/api/sync/v1/blob-uploads', {
    protocolVersion: '1.0', hash: uploadHash, size: uploadBytes.byteLength, chunkSize: 3,
  }, paired.token);
  assert.equal(uploadResponse.status, 201);
  const upload = await uploadResponse.json() as { uploadId: string };
  for (let part = 0; part < 2; part += 1) {
    const response = await fetch(`${base}/api/sync/v1/blob-uploads/${upload.uploadId}/${part}`, {
      method: 'PUT', headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/octet-stream' },
      body: uploadBytes.slice(part * 3, part * 3 + 3),
    });
    assert.equal(response.status, 204);
  }
  const completed = await post(base, `/api/sync/v1/blob-uploads/${upload.uploadId}/complete`, {}, paired.token);
  assert.equal(completed.status, 200);
  const blobResponse = await fetch(`${base}/api/sync/v1/blobs/${uploadHash}`, {
    headers: { authorization: `Bearer ${paired.token}`, range: 'bytes=1-3' },
  });
  assert.equal(blobResponse.status, 206);
  assert.equal(await blobResponse.text(), 'plo');

  const browserHandshake = await fetch(`${base}/api/sync/v1/handshake`, {
    method: 'POST', headers: {
      'content-type': 'application/json', cookie: `wo_sync_device=${paired.token}`,
      origin: base, 'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ protocolVersion: '1.0', deviceId: paired.deviceId, capabilities: [] }),
  });
  assert.equal(browserHandshake.status, 200);
  const crossOriginHandshake = await fetch(`${base}/api/sync/v1/handshake`, {
    method: 'POST', headers: {
      'content-type': 'application/json', cookie: `wo_sync_device=${paired.token}`,
      origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site',
    },
    body: JSON.stringify({ protocolVersion: '1.0', deviceId: paired.deviceId, capabilities: [] }),
  });
  assert.equal(crossOriginHandshake.status, 403);

  const ticketResponse = await post(base, '/api/sync/v1/ws-tickets', {}, paired.token);
  assert.equal(ticketResponse.status, 201);
  const ticket = (await ticketResponse.json()) as { ticket: string };
  assert.equal(wsTickets.consume(ticket.ticket), paired.deviceId);
  assert.equal(wsTickets.consume(ticket.ticket), null);

  await getSyncDeviceStore().revoke(paired.deviceId);
  const revoked = await post(base, '/api/sync/v1/handshake', { protocolVersion: '1.0', capabilities: [] }, paired.token);
  assert.equal(revoked.status, 403);
  assert.equal(((await revoked.json()) as { error: { code: string } }).error.code, 'device_revoked');
});

test('WebSocket tickets expire and are one-use', async () => {
  const store = new WsTicketStore(1_000);
  const first = store.issue('device_ticket_test_1');
  assert.equal(store.consume(first.ticket), 'device_ticket_test_1');
  assert.equal(store.consume(first.ticket), null);
  const expiryStore = new WsTicketStore(1);
  const expired = expiryStore.issue('device_ticket_test_1');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(expiryStore.consume(expired.ticket), null);
});

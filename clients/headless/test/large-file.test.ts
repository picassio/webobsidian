import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { FilesystemAdapter } from '../src/fs-adapter.js';
import { HeadlessStore } from '../src/state.js';
import { NodeSyncTransport } from '../src/transport.js';

test('1 GiB sparse attachment hashes through bounded streaming memory', { timeout: 120_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-vault-large-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new HeadlessStore(path.join(root, 'config'));
  await store.initialize({ serverUrl: 'http://localhost:3000', vaultPath: path.join(root, 'vault') });
  const file = path.join(store.state.vaultPath, 'large.bin');
  const handle = await fs.open(file, 'w'); try { await handle.truncate(1024 ** 3); } finally { await handle.close(); }
  const adapter = new FilesystemAdapter(store, {} as never, () => {}); await adapter.initialize();
  const before = process.memoryUsage().rss;
  const started = performance.now();
  const result = await adapter.hash('large.bin');
  const delta = process.memoryUsage().rss - before;
  t.diagnostic(`1 GiB streamed hash ${(performance.now() - started).toFixed(1)} ms; RSS delta ${(delta / 1024 / 1024).toFixed(1)} MiB`);
  assert.equal(result.size, 1024 ** 3);
  assert.match(result.hash, /^[a-f0-9]{64}$/);
  assert.ok(delta < 128 * 1024 * 1024, `RSS grew by ${(delta / 1024 / 1024).toFixed(1)} MiB`);

  let received = 0;
  const parts = Array.from({ length: 128 }, (_, index) => index);
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url?.endsWith('/blob-uploads')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ protocolVersion: '1.0', uploadId: 'upload_large_stream_1', missingParts: parts, expiresAt: '2026-07-14T00:00:00.000Z' }));
      return;
    }
    if (request.method === 'PUT' && request.url?.includes('/blob-uploads/')) {
      request.on('data', (chunk) => { received += chunk.length; });
      request.on('end', () => { response.statusCode = 204; response.end(); });
      return;
    }
    if (request.method === 'POST' && request.url?.endsWith('/complete')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ protocolVersion: '1.0', hash: result.hash, size: 1024 ** 3, deduplicated: false }));
      return;
    }
    response.statusCode = 404; response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const transport = new NodeSyncTransport(`http://127.0.0.1:${address.port}`, 'dvt_test.token');
  const uploadBaseline = process.memoryUsage().rss; let peak = uploadBaseline;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  const uploadStarted = performance.now();
  try { await transport.uploadFile(file, result.hash, result.size); } finally { clearInterval(sampler); }
  peak = Math.max(peak, process.memoryUsage().rss);
  t.diagnostic(`1 GiB loopback chunk upload ${(performance.now() - uploadStarted).toFixed(1)} ms; peak RSS delta ${((peak - uploadBaseline) / 1024 / 1024).toFixed(1)} MiB`);
  assert.equal(received, 1024 ** 3);
  assert.ok(peak - uploadBaseline < 128 * 1024 * 1024, `upload RSS grew by ${(peak - uploadBaseline) / 1024 / 1024} MiB`);
});

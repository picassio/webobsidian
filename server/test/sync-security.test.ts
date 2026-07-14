import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import test from 'node:test';
import { SYNC_RATE_LIMITS, syncRateLimit, requireSyncAdminCsrf } from '../src/middleware/sync-rate-limit.js';

async function withServer(app: express.Express, run: (base: string) => Promise<void>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('sync rate limiter emits canonical retryable 429 and Retry-After', async () => {
  const app = express();
  app.get('/limited', syncRateLimit('test-low', 2, () => 'caller'), (_req, res) => res.json({ ok: true }));
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/limited`)).status, 200);
    assert.equal((await fetch(`${base}/limited`)).status, 200);
    const limited = await fetch(`${base}/limited`);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
    const body = await limited.json() as { error: { code: string; retryable: boolean; details: { retryAfter: number } } };
    assert.equal(body.error.code, 'rate_limited');
    assert.equal(body.error.retryable, true);
    assert.ok(body.error.details.retryAfter >= 1);
  });
});

test('control probes remain independent from bootstrap transfer throttling', async () => {
  assert.equal(SYNC_RATE_LIMITS.deviceControlPerMinute, 120);
  assert.equal(SYNC_RATE_LIMITS.deviceTransferPerMinute, 600);
  const app = express();
  app.get('/control', syncRateLimit('test-control', 1, () => 'same-device'), (_req, res) => res.json({ ok: true }));
  app.get('/transfer', syncRateLimit('test-transfer', 1, () => 'same-device'), (_req, res) => res.json({ ok: true }));
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/transfer`)).status, 200);
    assert.equal((await fetch(`${base}/transfer`)).status, 429);
    assert.equal((await fetch(`${base}/control`)).status, 200);
    assert.equal((await fetch(`${base}/control`)).status, 429);
  });
});

test('sync admin CSRF guard rejects cross-origin and cross-site mutations', async () => {
  const app = express();
  app.post('/admin', requireSyncAdminCsrf, (_req, res) => res.status(204).end());
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/admin`, { method: 'POST' })).status, 204);
    assert.equal((await fetch(`${base}/admin`, { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/admin`, { method: 'POST', headers: { origin: base.replace('http:', 'https:') } })).status, 403);
    assert.equal((await fetch(`${base}/admin`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  });
});

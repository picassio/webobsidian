import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'webobsidian-multi-vault-e2e-'));
const data = path.join(root, 'data');
const vaultA = path.join(root, 'vault-a');
const vaultB = path.join(root, 'vault-b');
await Promise.all([mkdir(data), mkdir(vaultA), mkdir(vaultB)]);
const port = 18791;
const base = `http://127.0.0.1:${port}`;
let server;
let cookie = '';

function start() {
  server = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, VAULT_PATH: vaultA, ALLOWED_ROOTS: root, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(process.stdout);
  server.stderr.pipe(process.stderr);
}

async function stop() {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
}

async function waitHealthy() {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try { const response = await fetch(`${base}/healthz`); if (response.ok) return response.json(); } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not become healthy');
}

async function request(url, { vaultId, token, ...init } = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  if (vaultId) headers.set('X-WebObsidian-Vault-Id', vaultId);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${base}${url}`, { ...init, headers });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, body };
}

try {
  start();
  await waitHealthy();
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '123456' }) });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie);

  const listed = await request('/api/vaults');
  const idA = listed.body.defaultVaultId;
  assert.equal(listed.body.vaults[0].health.readOnly, false);
  assert.equal(listed.body.vaults[0].health.latestSequence, 0);
  const registered = await request('/api/vaults', {
    method: 'POST',
    headers: { origin: base, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ name: 'Vault B', path: vaultB }),
  });
  assert.equal(registered.response.status, 201, JSON.stringify(registered.body));
  const idB = registered.body.vault.id;
  assert.notEqual(idA, idB);
  const managed = await request('/api/vaults', {
    method: 'POST',
    headers: { origin: base, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ name: 'Created Vault C', create: true }),
  });
  assert.equal(managed.response.status, 201, JSON.stringify(managed.body));
  assert.equal(managed.body.created, true);
  const idC = managed.body.vault.id;
  assert.equal(path.dirname(managed.body.vault.path), root);
  assert.equal((await stat(managed.body.vault.path)).isDirectory(), true);
  assert.deepEqual(await readdir(managed.body.vault.path), []);

  for (const [vaultId, content] of [[idA, 'alpha'], [idB, 'bravo']]) {
    const write = await request('/api/files/content', { vaultId, method: 'PUT', body: JSON.stringify({ path: 'same.md', content }) });
    assert.equal(write.response.status, 200, JSON.stringify(write.body));
  }
  assert.equal((await request('/api/files/content?path=same.md', { vaultId: idA })).body.content, 'alpha');
  assert.equal((await request('/api/files/content?path=same.md', { vaultId: idB })).body.content, 'bravo');
  assert.equal(await readFile(path.join(vaultA, 'same.md'), 'utf8'), 'alpha');
  assert.equal(await readFile(path.join(vaultB, 'same.md'), 'utf8'), 'bravo');

  async function pair(vaultId, suffix) {
    const issued = await request('/api/sync/v1/pairing-codes', {
      vaultId, method: 'POST', headers: { origin: base, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ deviceNameHint: suffix }),
    });
    assert.equal(issued.response.status, 201, JSON.stringify(issued.body));
    const paired = await request('/api/sync/v1/pair', {
      method: 'POST', body: JSON.stringify({ protocolVersion: '1.0', code: issued.body.code, deviceId: `device_multi_${suffix}_123456789`, deviceName: suffix }),
    });
    assert.equal(paired.response.status, 201, JSON.stringify(paired.body));
    return paired.body;
  }
  const pairedA = await pair(idA, 'A');
  const pairedB = await pair(idB, 'B');
  for (const [paired, forged] of [[pairedA, idB], [pairedB, idA]]) {
    const handshake = await request('/api/sync/v1/handshake', {
      vaultId: forged, token: paired.token, method: 'POST',
      body: JSON.stringify({ protocolVersion: '1.0', deviceId: paired.deviceId, deviceName: 'test', lastAppliedSequence: 0, capabilities: [] }),
    });
    assert.equal(handshake.response.status, 200, JSON.stringify(handshake.body));
    assert.equal(handshake.body.vaultId, paired.vaultId);
  }

  const createdKey = await request('/api/keys/', { vaultId: idA, method: 'POST', body: JSON.stringify({ name: 'A only', scopes: ['read'] }) });
  assert.equal(createdKey.response.status, 200, JSON.stringify(createdKey.body));
  cookie = '';
  const keyA = await request('/api/v1/notes', { vaultId: idA, token: createdKey.body.key });
  const keyB = await request('/api/v1/notes', { vaultId: idB, token: createdKey.body.key });
  assert.equal(keyA.response.status, 200);
  assert.equal(keyB.response.status, 403);

  await stop();
  start();
  const health = await waitHealthy();
  assert.equal(health.vaults.length, 3);
  cookie = '';
  const relogin = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '123456' }) });
  cookie = relogin.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.equal((await request('/api/files/content?path=same.md', { vaultId: idA })).body.content, 'alpha');
  assert.equal((await request('/api/files/content?path=same.md', { vaultId: idB })).body.content, 'bravo');
  console.log(JSON.stringify({ ok: true, vaults: [idA, idB, idC], managedCreate: true, tokenHeaderOverrideDenied: true, apiKeyIsolation: true, restart: true }));
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}

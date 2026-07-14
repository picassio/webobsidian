import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { sha256Text } from '../packages/sync-core/dist/index.js';

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-browser-pair-'));
const data = path.join(work, 'data'); const vault = path.join(work, 'vault');
await fs.mkdir(data); await fs.mkdir(vault);
const port = 32_000 + Math.floor(Math.random() * 1_000); const base = `http://127.0.0.1:${port}`;
const password = 'Browser-E2E-Strong-2026!';
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(port), DATA_DIR: data, VAULT_PATH: vault, WEBOBSIDIAN_PASSWORD: password, NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = ''; server.stdout.on('data', (chunk) => { serverLog += chunk; }); server.stderr.on('data', (chunk) => { serverLog += chunk; });
let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const contextA = await browser.newContext(); const contextB = await browser.newContext();
  let pageA = await contextA.newPage(); let pageB = await contextB.newPage();
  await loginAndPair(pageA, 'Browser A');
  await loginAndPair(pageB, 'Browser B');
  await verifyExternalPairingCodeUi(pageA);

  const [differentA, differentB] = await Promise.all([
    operation(pageA, createOperation('Different-A.md', 'from A')),
    operation(pageB, createOperation('Different-B.md', 'from B')),
  ]);
  assert.equal(differentA.status, 'accepted'); assert.equal(differentB.status, 'accepted');
  await Promise.all([
    waitEntry(pageA, 'Different-B.md'), waitEntry(pageB, 'Different-A.md'),
  ]);

  const shared = await operation(pageA, createOperation('Shared.md', 'base'));
  await Promise.all([waitEntry(pageA, 'Shared.md'), waitEntry(pageB, 'Shared.md')]);
  const accepted = await operation(pageA, modifyOperation(shared, 'server edit'));
  const conflict = await operation(pageB, modifyOperation(shared, 'stale client edit'));
  assert.equal(accepted.status, 'accepted'); assert.equal(conflict.status, 'conflict');
  await waitFor(async () => (await deviceJson(pageB, '/conflicts')).conflicts.some((item) => item.status === 'unresolved'));

  // An open stale note retains its overlapping local draft when a remote revision arrives.
  const stale = await operation(pageA, createOperation('Stale.md', 'base'));
  await Promise.all([waitEntry(pageA, 'Stale.md'), waitEntry(pageB, 'Stale.md')]);
  await pageB.getByText('Stale', { exact: true }).click();
  const editor = pageB.locator('.cm-content'); await editor.waitFor();
  await contextB.setOffline(true); await editor.fill('local overlapping draft'); await pageB.waitForTimeout(1_000);
  await operation(pageA, modifyOperation(stale, 'remote overlapping revision'));
  await contextB.setOffline(false);
  await waitFor(async () => (await editor.innerText()).includes('local overlapping draft'), 20_000);

  // Binary attachment uses resumable blob transfer and materializes as metadata on both browsers.
  const attachmentDir = await operation(pageA, { operation: 'mkdir', path: 'attachments', kind: 'directory' });
  assert.equal(attachmentDir.status, 'accepted'); await waitEntry(pageB, 'attachments');
  const binary = Buffer.from([0, 1, 2, 3, 255, 128, 64]);
  const binaryHash = createHash('sha256').update(binary).digest('hex');
  await uploadBlob(pageA, binary, binaryHash);
  const binaryResult = await operation(pageA, {
    operation: 'create', path: 'attachments/e2e.bin', kind: 'file',
    content: { hash: binaryHash, size: binary.length, blobHash: binaryHash },
  });
  assert.equal(binaryResult.status, 'accepted');
  await Promise.all([waitEntry(pageA, 'attachments/e2e.bin'), waitEntry(pageB, 'attachments/e2e.bin')]);

  // Durable offline queue survives page destruction and flushes on a new page.
  await contextB.setOffline(true);
  await queueOfflineCreate(pageB, 'Offline.md', 'queued while offline');
  await pageB.close(); await contextB.setOffline(false); pageB = await contextB.newPage(); await pageB.goto(base);
  await waitEntry(pageB, 'Offline.md', 30_000); await waitEntry(pageA, 'Offline.md', 30_000);

  // A pending apply intent written before local materialization is recovered on reload.
  await contextB.setOffline(true);
  const crash = await operation(pageA, createOperation('Crash-Recovery.md', 'recover me'));
  const changes = await deviceJson(pageA, `/changes?after=${crash.sequence - 1}&limit=10`);
  const crashEvent = changes.events.find((event) => event.eventId === crash.eventId); assert.ok(crashEvent);
  await putKv(pageB, `apply:${crashEvent.eventId}`, { event: crashEvent, createdAt: new Date().toISOString() });
  await contextB.setOffline(false); await pageB.reload();
  await waitEntry(pageB, 'Crash-Recovery.md', 30_000);

  // Rename and delete converge by stable identity on both real browser adapters.
  const crashProjection = await getEntry(pageA, 'Crash-Recovery.md');
  const renamed = await operation(pageA, {
    operation: 'rename', entryId: crashProjection.entryId, baseRevision: crashProjection.revision,
    path: 'Crash-Renamed.md',
  });
  assert.equal(renamed.status, 'accepted'); await waitEntry(pageB, 'Crash-Renamed.md');
  const deleted = await operation(pageB, {
    operation: 'delete', entryId: renamed.entryId, baseRevision: renamed.revision,
  });
  assert.equal(deleted.status, 'accepted');
  await waitFor(async () => (await getEntry(pageA, 'Crash-Renamed.md'))?.deleted === true, 30_000);

  // Confirm browser credentials are inaccessible and never serialized in IndexedDB.
  for (const page of [pageA, pageB]) {
    const evidence = await page.evaluate(async () => {
      const device = await idbGet('device');
      return { device, cookies: document.cookie };
      function idbGet(key) { return new Promise((resolve, reject) => { const open = indexedDB.open('webobsidian-sync-v1', 1); open.onsuccess = () => { const request = open.result.transaction('kv').objectStore('kv').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }; open.onerror = () => reject(open.error); }); }
    });
    assert.equal('token' in evidence.device, false); assert.equal(evidence.cookies.includes('wo_sync_device'), false);
  }
  console.log('browser-pair E2E: two-browser concurrency, stale-open draft, conflict, binary blob, offline restart, apply-intent recovery, rename/delete, and httpOnly identity passed');
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (server.exitCode === null) server.kill('SIGKILL');
  await fs.rm(work, { recursive: true, force: true });
}

async function waitForServer() {
  await waitFor(async () => {
    try { return (await fetch(`${base}/auth/status`)).ok; } catch { return false; }
  }, 20_000, () => `server failed to start\n${serverLog}`);
}
async function verifyExternalPairingCodeUi(page) {
  await page.locator('button[title="Settings"]').first().click();
  await page.getByRole('button', { name: 'Create vault', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Central Sync' }).click();
  const syncVault = page.getByLabel('Central Sync vault');
  assert.match(await syncVault.inputValue(), /^vault_/u);
  await page.getByText(/Connected devices .* \(2\)/u).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Disconnect' }).count(), 2);
  await page.getByLabel('Pairing device name').fill('Browser E2E external client');
  page.once('dialog', async (dialog) => {
    assert.match(dialog.message(), /device name does not create a vault/i);
    assert.match(dialog.message(), /server vault/i);
    await dialog.accept();
  });
  await page.getByRole('button', { name: /Create code for/ }).click();
  const code = await page.getByLabel('One-use pairing code').inputValue();
  assert.match(code, /^pair_[A-Za-z0-9_-]{32}$/u);
  await page.locator('.modal-bg').click({ position: { x: 4, y: 4 } });
}
async function loginAndPair(page, name) {
  await page.goto(base);
  const login = await page.evaluate(async ({ password }) => {
    const response = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    return { status: response.status, body: await response.json() };
  }, { password });
  assert.equal(login.status, 200);
  if (login.body.mustChangePassword) {
    const changed = await page.evaluate(async ({ password }) => (await fetch('/auth/change-password', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: password, newPassword: password }),
    })).status, { password });
    assert.equal(changed, 200);
  }
  const deviceId = `web_${crypto.randomUUID().replaceAll('-', '')}`;
  const paired = await page.evaluate(async ({ deviceId, name }) => {
    const response = await fetch('/api/sync/v1/browser-devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, deviceName: name }) });
    return { status: response.status, body: await response.json() };
  }, { deviceId, name });
  assert.equal(paired.status, 201, JSON.stringify(paired.body)); assert.equal('token' in paired.body, false);
  await putKv(page, 'device', { deviceId, deviceName: name, vaultId: paired.body.vaultId, cursor: 0, nextClientSequence: 1 });
  await page.reload();
  await waitFor(async () => (await page.evaluate(async (deviceId) => (await fetch('/api/sync/v1/handshake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: '1.0', deviceId, capabilities: [] }) })).status, deviceId)) === 200);
}
function createOperation(pathValue, content) {
  return { operation: 'create', path: pathValue, kind: 'file', content: { hash: sha256Text(content), size: Buffer.byteLength(content), inlineText: content } };
}
function modifyOperation(result, content) {
  return { operation: 'modify', entryId: result.entryId, baseRevision: result.revision, content: { hash: sha256Text(content), size: Buffer.byteLength(content), inlineText: content } };
}
async function operation(page, partial) {
  return page.evaluate(async (partial) => {
    const db = await openDb(); const transaction = db.transaction('kv', 'readwrite', { durability: 'strict' }); const store = transaction.objectStore('kv');
    const device = await request(store.get('device')); const clientSequence = device.nextClientSequence; device.nextClientSequence += 1; store.put(device, 'device'); await done(transaction);
    const operation = { ...partial, clientSequence, idempotencyKey: `browser-e2e-${crypto.randomUUID()}` };
    const response = await fetch('/api/sync/v1/operations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: '1.0', operations: [operation] }) });
    const payload = await response.json(); if (!response.ok) throw new Error(JSON.stringify(payload)); return payload.results[0];
    function openDb() { return new Promise((resolve, reject) => { const value = indexedDB.open('webobsidian-sync-v1', 1); value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); }); }
    function request(value) { return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); }); }
    function done(value) { return new Promise((resolve, reject) => { value.oncomplete = resolve; value.onerror = () => reject(value.error); value.onabort = () => reject(value.error); }); }
  }, partial);
}
async function queueOfflineCreate(page, pathValue, content) {
  const hash = sha256Text(content);
  await page.evaluate(async ({ pathValue, content, hash }) => {
    const db = await openDb(); const tx = db.transaction('kv', 'readwrite', { durability: 'strict' }); const store = tx.objectStore('kv');
    const device = await request(store.get('device')); const clientSequence = device.nextClientSequence; device.nextClientSequence += 1; store.put(device, 'device');
    const value = { operation: 'create', path: pathValue, kind: 'file', clientSequence, idempotencyKey: `browser-offline-${crypto.randomUUID()}`, content: { hash, size: new TextEncoder().encode(content).byteLength, inlineText: content } };
    store.put(value, `operation:${value.idempotencyKey}`); await done(tx);
    function openDb() { return new Promise((resolve, reject) => { const value = indexedDB.open('webobsidian-sync-v1', 1); value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); }); }
    function request(value) { return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); }); }
    function done(value) { return new Promise((resolve, reject) => { value.oncomplete = resolve; value.onerror = () => reject(value.error); value.onabort = () => reject(value.error); }); }
  }, { pathValue, content, hash });
}
async function uploadBlob(page, bytes, hash) {
  await page.evaluate(async ({ bytes, hash }) => {
    const createdResponse = await fetch('/api/sync/v1/blob-uploads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: '1.0', hash, size: bytes.length, chunkSize: 8 * 1024 * 1024 }),
    });
    const created = await createdResponse.json(); if (!createdResponse.ok) throw new Error(JSON.stringify(created));
    for (const part of created.missingParts) {
      const response = await fetch(`/api/sync/v1/blob-uploads/${encodeURIComponent(created.uploadId)}/${part}`, {
        method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes),
      });
      if (!response.ok) throw new Error(`part upload ${response.status}`);
    }
    const completed = await fetch(`/api/sync/v1/blob-uploads/${encodeURIComponent(created.uploadId)}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!completed.ok) throw new Error(await completed.text());
  }, { bytes: [...bytes], hash });
}
async function deviceJson(page, pathValue) {
  return page.evaluate(async (pathValue) => { const response = await fetch(`/api/sync/v1${pathValue}`); const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body; }, pathValue);
}
async function putKv(page, key, value) {
  await page.evaluate(async ({ key, value }) => {
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open('webobsidian-sync-v1', 1); open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv'); }; open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('kv', 'readwrite', { durability: 'strict' }); tx.objectStore('kv').put(value, key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  }, { key, value });
}
async function getEntry(page, pathValue) {
  return page.evaluate(async (pathValue) => {
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open('webobsidian-sync-v1', 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const values = await new Promise((resolve, reject) => { const request = db.transaction('kv').objectStore('kv').getAll(IDBKeyRange.bound('entry:', 'entry:\uffff')); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    return values.find((entry) => entry.path === pathValue) ?? null;
  }, pathValue);
}
async function waitEntry(page, pathValue, timeout = 20_000) { return waitFor(async () => { const entry = await getEntry(page, pathValue); return entry && !entry.deleted ? entry : false; }, timeout); }
async function waitFor(check, timeout = 20_000, failure = () => `condition not met after ${timeout} ms`) {
  const deadline = Date.now() + timeout; let lastError;
  while (Date.now() < deadline) { try { const result = await check(); if (result) return result; } catch (error) { lastError = error; } await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`${failure()}${lastError ? `: ${lastError}` : ''}`);
}

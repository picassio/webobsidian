import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repository = path.resolve(import.meta.dirname, '..');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-headless-pair-'));
const data = path.join(work, 'data');
const serverVault = path.join(work, 'server-vault');
const clientA = profile('a');
const clientB = profile('b');
const port = 33_000 + Math.floor(Math.random() * 1_000);
const base = `http://127.0.0.1:${port}`;
const password = 'Headless-E2E-Strong-2026!';
await Promise.all([data, serverVault, clientA.vault, clientA.config, clientB.vault, clientB.config].map((directory) => fs.mkdir(directory, { recursive: true })));

const server = spawn(process.execPath, ['server/dist/index.js'], {
  cwd: repository,
  env: { ...process.env, PORT: String(port), DATA_DIR: data, VAULT_PATH: serverVault, WEBOBSIDIAN_PASSWORD: password, NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

try {
  await waitFor(async () => {
    try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; }
  }, 20_000, () => `server failed to start\n${serverLog}`);

  for (const client of [clientA, clientB]) {
    await cli(client, ['init', '--server', base, '--vault', client.vault, '--mode', 'bidirectional', '--json']);
  }
  const cookie = await login();
  await cli(clientA, ['pair', '--code', await pairingCode(cookie, 'Headless E2E A'), '--json']);
  await cli(clientB, ['pair', '--code', await pairingCode(cookie, 'Headless E2E B'), '--json']);

  const sharedA = path.join(clientA.vault, 'shared.md');
  const sharedB = path.join(clientB.vault, 'shared.md');
  await fs.writeFile(sharedA, 'one base\nseparator\nthree base\n');
  await cli(clientA, ['sync', '--json']);
  await cli(clientB, ['sync', '--json']);

  await fs.writeFile(sharedA, 'one from A\nseparator\nthree base\n');
  await fs.writeFile(sharedB, 'one base\nseparator\nthree from B\n');
  await cli(clientA, ['sync', '--json']);
  const cleanMerge = await cli(clientB, ['sync', '--json']);
  await cli(clientA, ['sync', '--json']);
  assert.equal(cleanMerge.json.ok, true);
  assert.equal(cleanMerge.json.status, 'synced');
  assert.equal(cleanMerge.json.conflicts, 0);
  assert.equal(await fs.readFile(sharedA, 'utf8'), 'one from A\nseparator\nthree from B\n');
  assert.equal(await fs.readFile(sharedB, 'utf8'), await fs.readFile(sharedA, 'utf8'));
  await assert.rejects(() => fs.access(path.join(clientB.vault, '.web-vault-sync-quarantine')));

  await fs.writeFile(sharedA, 'overlap A\nseparator\nthree from B\n');
  await fs.writeFile(sharedB, 'overlap B\nseparator\nthree from B\n');
  await cli(clientA, ['sync', '--json']);
  const conflicting = await cli(clientB, ['sync', '--json'], 4);
  assert.equal(conflicting.json.status, 'conflict');
  const listed = await cli(clientB, ['conflicts', 'list', '--json'], 4);
  const unresolved = listed.json.conflicts?.find((conflict) => conflict.status === 'unresolved');
  assert.ok(unresolved?.conflictId);
  assert.equal(await fs.readFile(sharedB, 'utf8'), 'overlap A\nseparator\nthree from B\n');
  const conflictCopy = (await fs.readdir(clientB.vault)).find((name) => name.startsWith('shared (conflict from '));
  assert.ok(conflictCopy);
  assert.equal(await fs.readFile(path.join(clientB.vault, conflictCopy), 'utf8'), 'overlap B\nseparator\nthree from B\n');

  const segments = (await fs.readdir(path.join(data, 'sync', 'journal'))).filter((name) => /^\d+\.json$/u.test(name)).sort();
  const events = (await Promise.all(segments.map(async (name) => JSON.parse(await fs.readFile(path.join(data, 'sync', 'journal', name), 'utf8')).payload.events))).flat();
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
  assert.equal(new Set(events.map((event) => event.actor.id)).size, 2);
  assert.equal(events[4].path, conflictCopy);
  console.log('headless-pair E2E: two-client catch-up, clean stale merge, durable overlap conflict, and gapless journal passed');
} finally {
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (server.exitCode === null) server.kill('SIGKILL');
  await fs.rm(work, { recursive: true, force: true });
}

function profile(name) {
  return { config: path.join(work, `${name}-config`), vault: path.join(work, `${name}-vault`) };
}

async function login() {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200, await response.text());
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);
  return cookie;
}

async function pairingCode(cookie, deviceNameHint) {
  const response = await fetch(`${base}/api/sync/v1/pairing-codes`, {
    method: 'POST',
    headers: { cookie, origin: base, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ deviceNameHint }),
  });
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.match(payload.code, /^pair_/u);
  return payload.code;
}

async function cli(client, args, expectedCode = 0) {
  const result = await command(process.execPath, ['clients/headless/dist/cli.js', '--config-dir', client.config, ...args]);
  assert.equal(result.code, expectedCode, `CLI exited ${result.code}, expected ${expectedCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const values = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const json = values.at(-1);
  assert.ok(json && typeof json === 'object', `CLI emitted no JSON result\n${result.stdout}\n${result.stderr}`);
  return { ...result, json };
}

function command(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: repository, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
  });
}

async function waitFor(check, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message());
}

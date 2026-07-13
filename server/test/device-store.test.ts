import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { DeviceStore } from '../src/sync/device-store.js';

async function directory(t: TestContext) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-devices-'));
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}

test('pairing code is high entropy, single-use, expiring, and token is hashed at rest', async (t) => {
  const data = await directory(t);
  const store = new DeviceStore(data);
  const pairing = await store.createPairingCode('Laptop');
  assert.match(pairing.code, /^pair_[A-Za-z0-9_-]{32}$/);
  const paired = await store.pair(pairing.code, 'device_pairing_test_1', 'Laptop');
  assert.match(paired.token, /^dvt_device_pairing_test_1\./);
  assert.equal((await store.authenticate(paired.token))?.deviceId, paired.device.deviceId);
  const rotated = await store.rotateToken(paired.token);
  assert.notEqual(rotated.token, paired.token);
  assert.equal(await store.authenticate(paired.token), null);
  assert.equal((await store.authenticate(rotated.token))?.deviceId, paired.device.deviceId);
  await assert.rejects(() => store.rotateToken(paired.token), /invalid/);
  await assert.rejects(() => store.pair(pairing.code, 'device_pairing_test_2', 'Other'), /already used/);
  const raw = await fs.readFile(path.join(data, 'sync', 'devices.json'), 'utf8');
  assert.equal(raw.includes(paired.token), false);
  assert.equal(raw.includes(rotated.token), false);
  assert.equal(raw.includes(pairing.code), false);
});

test('acknowledgement is monotonic and revocation immediately invalidates token', async (t) => {
  const data = await directory(t);
  const store = new DeviceStore(data);
  const pairing = await store.createPairingCode();
  const paired = await store.pair(pairing.code, 'device_ack_test_0001', 'Headless');
  assert.equal((await store.acknowledge(paired.device.deviceId, 7)).acknowledgedSequence, 7);
  await assert.rejects(() => store.acknowledge(paired.device.deviceId, 6), /backwards/);
  assert.equal(await store.minimumActiveAcknowledgement(new Date(Date.now() - 60_000)), 7);
  await store.revoke(paired.device.deviceId);
  assert.equal(await store.authenticate(paired.token), null);
  assert.equal(await store.minimumActiveAcknowledgement(new Date(Date.now() - 60_000)), null);
  assert.equal((await store.list())[0]?.revokedAt !== null, true);
});

test('expired pairing code cannot be consumed', async (t) => {
  const data = await directory(t);
  const store = new DeviceStore(data, 1);
  const pairing = await store.createPairingCode();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(() => store.pair(pairing.code, 'device_expired_test_1', 'Expired'), /expired/);
});

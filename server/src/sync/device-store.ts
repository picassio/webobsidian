import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DeviceSchema, IdSchema, sha256Text } from '@picassio/sync-core';
import { AsyncMutex } from './locks.js';
import { AtomicJsonStore, ensureSyncStorage } from './storage.js';

const scrypt = promisify(scryptCallback);
const DEVICE_SCHEMA_VERSION = 1;
const TokenHashSchema = z.object({ salt: z.string().regex(/^[a-f0-9]{32}$/), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const StoredDeviceSchema = DeviceSchema.extend({ token: TokenHashSchema }).strict();
type StoredDevice = z.infer<typeof StoredDeviceSchema>;
const PairingSchema = z.object({
  codeHash: z.string().regex(/^[a-f0-9]{64}$/),
  deviceNameHint: z.string().min(1).max(128).optional(),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  consumedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
const AuditSchema = z.object({
  at: z.string().datetime({ offset: true }),
  action: z.enum(['pairing-created', 'paired', 'token-rotated', 'authenticated', 'acknowledged', 'revoked']),
  deviceId: IdSchema.nullable(),
  detail: z.string().max(256),
}).strict();
const StateSchema = z.object({
  schemaVersion: z.literal(DEVICE_SCHEMA_VERSION),
  devices: z.array(StoredDeviceSchema),
  pairingCodes: z.array(PairingSchema),
  audit: z.array(AuditSchema),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
type State = z.infer<typeof StateSchema>;

export type PublicDevice = z.infer<typeof DeviceSchema>;

export class DeviceStore {
  private state: State | null = null;
  private store: AtomicJsonStore<State> | null = null;
  private readonly mutex = new AsyncMutex();

  constructor(private readonly dataDir: string, private readonly pairingTtlMs = 10 * 60 * 1000) {}

  async createPairingCode(deviceNameHint?: string): Promise<{ code: string; expiresAt: string }> {
    return this.mutex.run(async () => {
      const state = await this.load();
      const now = new Date();
      const code = `pair_${randomBytes(24).toString('base64url')}`;
      const expiresAt = new Date(now.getTime() + this.pairingTtlMs).toISOString();
      const pairing = PairingSchema.parse({
        codeHash: sha256Text(code),
        ...(deviceNameHint ? { deviceNameHint } : {}),
        createdAt: now.toISOString(), expiresAt, consumedAt: null,
      });
      await this.write({
        ...state,
        pairingCodes: [...state.pairingCodes.filter((item) => Date.parse(item.expiresAt) > now.getTime()), pairing],
        audit: appendAudit(state.audit, { at: now.toISOString(), action: 'pairing-created', deviceId: null, detail: deviceNameHint ?? '' }),
      });
      return { code, expiresAt };
    });
  }

  async pair(code: string, deviceIdInput: string, deviceName: string): Promise<{ device: PublicDevice; token: string }> {
    return this.mutex.run(async () => {
      const deviceId = IdSchema.parse(deviceIdInput);
      const state = await this.load();
      const now = new Date();
      const codeHash = sha256Text(code);
      const pairing = state.pairingCodes.find((item) => secureHexEqual(item.codeHash, codeHash));
      if (!pairing || pairing.consumedAt || Date.parse(pairing.expiresAt) <= now.getTime()) throw new Error('pairing code is invalid, expired, or already used');
      const existing = state.devices.find((item) => item.deviceId === deviceId && !item.revokedAt);
      if (existing) throw new Error('device id is already paired');
      const secret = randomBytes(32).toString('base64url');
      const token = `dvt_${deviceId}.${secret}`;
      const tokenHash = await hashToken(secret);
      const publicDevice = DeviceSchema.parse({
        deviceId, name: deviceName, createdAt: now.toISOString(), lastSeenAt: now.toISOString(),
        acknowledgedSequence: 0, revokedAt: null,
      });
      const stored = StoredDeviceSchema.parse({ ...publicDevice, token: tokenHash });
      await this.write({
        ...state,
        devices: [...state.devices.filter((item) => item.deviceId !== deviceId), stored],
        pairingCodes: state.pairingCodes.map((item) => item === pairing ? { ...item, consumedAt: now.toISOString() } : item),
        audit: appendAudit(state.audit, { at: now.toISOString(), action: 'paired', deviceId, detail: deviceName }),
      });
      return { device: publicDevice, token };
    });
  }

  async rotateToken(token: string): Promise<{ device: PublicDevice; token: string }> {
    return this.mutex.run(async () => {
      const separator = token.lastIndexOf('.');
      if (!token.startsWith('dvt_') || separator < 5) throw new Error('device token is invalid');
      const deviceId = token.slice(4, separator);
      const secret = token.slice(separator + 1);
      const state = await this.load();
      const stored = state.devices.find((item) => item.deviceId === deviceId);
      if (!stored || stored.revokedAt || !(await verifyToken(secret, stored.token))) throw new Error('device token is invalid or revoked');
      const replacementSecret = randomBytes(32).toString('base64url');
      const replacementToken = `dvt_${deviceId}.${replacementSecret}`;
      const now = new Date().toISOString();
      const updated = StoredDeviceSchema.parse({ ...stored, token: await hashToken(replacementSecret), lastSeenAt: now });
      await this.write({
        ...state,
        devices: state.devices.map((item) => item.deviceId === deviceId ? updated : item),
        audit: appendAudit(state.audit, { at: now, action: 'token-rotated', deviceId, detail: 'browser-http-only-upgrade' }),
      });
      return { device: stripToken(updated), token: replacementToken };
    });
  }

  async authenticate(token: string): Promise<PublicDevice | null> {
    return (await this.authenticateDetailed(token)).device;
  }

  async authenticateDetailed(token: string): Promise<{ device: PublicDevice | null; reason: 'invalid' | 'revoked' | null }> {
    const separator = token.lastIndexOf('.');
    if (!token.startsWith('dvt_') || separator < 5) return { device: null, reason: 'invalid' };
    const deviceId = token.slice(4, separator);
    const secret = token.slice(separator + 1);
    const state = await this.load();
    const stored = state.devices.find((item) => item.deviceId === deviceId);
    if (!stored || !(await verifyToken(secret, stored.token))) return { device: null, reason: 'invalid' };
    if (stored.revokedAt) return { device: null, reason: 'revoked' };
    const lastSeen = stored.lastSeenAt ? Date.parse(stored.lastSeenAt) : 0;
    if (Date.now() - lastSeen > 60_000) {
      await this.mutex.run(async () => {
        const fresh = await this.load();
        const now = new Date().toISOString();
        await this.write({
          ...fresh,
          devices: fresh.devices.map((item) => item.deviceId === deviceId ? { ...item, lastSeenAt: now } : item),
          audit: appendAudit(fresh.audit, { at: now, action: 'authenticated', deviceId, detail: '' }),
        });
      });
    }
    return { device: stripToken(stored), reason: null };
  }

  async acknowledge(deviceId: string, sequence: number): Promise<PublicDevice> {
    return this.mutex.run(async () => {
      const state = await this.load();
      const existing = state.devices.find((item) => item.deviceId === deviceId);
      if (!existing || existing.revokedAt) throw new Error('device is missing or revoked');
      if (!Number.isSafeInteger(sequence) || sequence < existing.acknowledgedSequence) throw new Error('acknowledgement cannot move backwards');
      const now = new Date().toISOString();
      const updated = StoredDeviceSchema.parse({ ...existing, acknowledgedSequence: sequence, lastSeenAt: now });
      await this.write({
        ...state,
        devices: state.devices.map((item) => item.deviceId === deviceId ? updated : item),
        audit: appendAudit(state.audit, { at: now, action: 'acknowledged', deviceId, detail: String(sequence) }),
      });
      return stripToken(updated);
    });
  }

  async revoke(deviceId: string): Promise<PublicDevice> {
    return this.mutex.run(async () => {
      const state = await this.load();
      const existing = state.devices.find((item) => item.deviceId === deviceId);
      if (!existing) throw new Error('unknown device');
      const now = new Date().toISOString();
      const updated = StoredDeviceSchema.parse({ ...existing, revokedAt: existing.revokedAt ?? now });
      await this.write({
        ...state,
        devices: state.devices.map((item) => item.deviceId === deviceId ? updated : item),
        audit: appendAudit(state.audit, { at: now, action: 'revoked', deviceId, detail: '' }),
      });
      return stripToken(updated);
    });
  }

  async list(): Promise<PublicDevice[]> {
    return (await this.load()).devices.map(stripToken);
  }

  async minimumActiveAcknowledgement(inactiveBefore: Date): Promise<number | null> {
    const active = (await this.load()).devices.filter(
      (device) => !device.revokedAt && device.lastSeenAt && Date.parse(device.lastSeenAt) >= inactiveBefore.getTime(),
    );
    return active.length ? Math.min(...active.map((device) => device.acknowledgedSequence)) : null;
  }

  private async load(): Promise<State> {
    if (this.state) return this.state;
    const paths = await ensureSyncStorage(this.dataDir);
    this.store = new AtomicJsonStore(path.join(paths.root, 'devices.json'), StateSchema);
    this.state = await this.store.read() ?? {
      schemaVersion: DEVICE_SCHEMA_VERSION, devices: [], pairingCodes: [], audit: [], updatedAt: new Date().toISOString(),
    };
    return this.state;
  }

  private async write(input: Omit<State, 'updatedAt'> & { updatedAt?: string }): Promise<void> {
    await this.load();
    const state = StateSchema.parse({ ...input, updatedAt: new Date().toISOString() });
    await this.store!.write(state);
    this.state = state;
  }
}

function stripToken(device: StoredDevice): PublicDevice {
  const { token: _token, ...publicDevice } = device;
  return DeviceSchema.parse(publicDevice);
}

async function hashToken(secret: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(secret, Buffer.from(salt, 'hex'), 32) as Buffer;
  return { salt, hash: derived.toString('hex') };
}

async function verifyToken(secret: string, stored: z.infer<typeof TokenHashSchema>): Promise<boolean> {
  const derived = await scrypt(secret, Buffer.from(stored.salt, 'hex'), 32) as Buffer;
  return timingSafeEqual(derived, Buffer.from(stored.hash, 'hex'));
}

function secureHexEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function appendAudit(audit: State['audit'], item: State['audit'][number]) {
  return [...audit, AuditSchema.parse(item)].slice(-10_000);
}

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sha256Text,
  type ClientApplyIntent,
  type ClientDeviceIdentity,
  type SyncClientPersistence,
  type SyncEntry,
  type SyncOperation,
} from '@picassio/sync-core';

export type SyncMode = 'bidirectional' | 'pull-only' | 'push-only';
export interface PendingPath { path: string; action: 'upsert' | 'rename' | 'delete'; oldPath?: string; observedAt: string }
export interface HeadlessState {
  schemaVersion: 1;
  serverUrl: string;
  vaultPath: string;
  deviceId: string | null;
  deviceName: string;
  vaultId: string | null;
  cursor: number;
  nextClientSequence: number;
  mode: SyncMode;
  pollSeconds: number;
  excludeGlobs: string[];
  operations: SyncOperation[];
  applyIntents: ClientApplyIntent[];
  entries: SyncEntry[];
  pendingPaths: PendingPath[];
  mergedSources: Record<string, string>;
  lastError: string | null;
  lastSyncAt: string | null;
}
interface Envelope { envelopeVersion: 1; checksum: string; payload: HeadlessState }

export class HeadlessStore implements SyncClientPersistence {
  state!: HeadlessState;
  private writes: Promise<void> = Promise.resolve();
  readonly stateFile: string;
  readonly tokenFile: string;
  readonly lockFile: string;
  constructor(readonly configDir: string) {
    this.stateFile = path.join(configDir, 'state.json');
    this.tokenFile = path.join(configDir, 'token');
    this.lockFile = path.join(configDir, 'daemon.lock');
  }

  static configDirectory(profile = 'default', override?: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile)) throw new Error('profile must use letters, numbers, underscore, or dash');
    return path.resolve(override ?? process.env.WEB_VAULT_SYNC_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'web-vault-sync', profile));
  }
  async initialize(input?: Partial<Pick<HeadlessState, 'serverUrl' | 'vaultPath' | 'deviceName' | 'mode'>>): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.configDir, 0o700);
    const existing = await this.read();
    if (existing) { this.state = existing; return; }
    if (!input?.serverUrl || !input.vaultPath) throw new Error('state is not initialized; run init');
    this.state = {
      schemaVersion: 1, serverUrl: input.serverUrl, vaultPath: path.resolve(input.vaultPath),
      deviceId: null, deviceName: input.deviceName ?? os.hostname(), vaultId: null,
      cursor: 0, nextClientSequence: 1, mode: input.mode ?? 'bidirectional', pollSeconds: 15,
      excludeGlobs: [], operations: [], applyIntents: [], entries: [], pendingPaths: [], mergedSources: {},
      lastError: null, lastSyncAt: null,
    };
    await fs.mkdir(this.state.vaultPath, { recursive: true });
    const vaultReal = await fs.realpath(this.state.vaultPath);
    const configReal = await fs.realpath(this.configDir);
    if (configReal === vaultReal || configReal.startsWith(`${vaultReal}${path.sep}`)) throw new Error('client config/state must be outside the vault');
    await this.save();
  }
  async load(): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true, mode: 0o700 });
    const loaded = await this.read();
    if (!loaded) throw new Error('state is not initialized; run init');
    this.state = loaded;
  }
  async save(): Promise<void> {
    const payload = structuredClone(this.state);
    const write = this.writes.then(() => atomicWrite(this.stateFile, payload));
    this.writes = write.catch(() => undefined);
    return write;
  }
  async update(mutator: (state: HeadlessState) => void): Promise<void> { mutator(this.state); await this.save(); }

  async token(): Promise<string | null> {
    if (process.env.WEB_VAULT_SYNC_TOKEN) return process.env.WEB_VAULT_SYNC_TOKEN;
    if (process.env.WEB_VAULT_SYNC_TOKEN_FILE) {
      const token = (await fs.readFile(process.env.WEB_VAULT_SYNC_TOKEN_FILE, 'utf8')).trim();
      if (token) return token;
    }
    if (process.env.CREDENTIALS_DIRECTORY) {
      try {
        const credential = (await fs.readFile(path.join(process.env.CREDENTIALS_DIRECTORY, 'sync-token'), 'utf8')).trim();
        if (credential) return credential;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try {
      const stat = await fs.stat(this.tokenFile);
      if ((stat.mode & 0o077) !== 0) throw new Error(`token file must be mode 0600: ${this.tokenFile}`);
      const token = (await fs.readFile(this.tokenFile, 'utf8')).trim();
      return token || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async setToken(token: string): Promise<void> {
    const handle = await fs.open(this.tokenFile, 'w', 0o600);
    try { await handle.writeFile(`${token}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await fs.chmod(this.tokenFile, 0o600);
  }
  async clearToken(): Promise<void> { await fs.rm(this.tokenFile, { force: true }); }
  async getDevice(): Promise<ClientDeviceIdentity | null> {
    const token = await this.token();
    if (!token || !this.state.deviceId || !this.state.vaultId) return null;
    return { deviceId: this.state.deviceId, deviceName: this.state.deviceName, token, vaultId: this.state.vaultId, cursor: this.state.cursor };
  }
  async putCursor(cursor: number) {
    if (cursor < this.state.cursor) throw new Error('cursor cannot move backwards');
    await this.update((state) => { state.cursor = cursor; });
  }
  async takeClientSequence(): Promise<number> {
    const sequence = this.state.nextClientSequence;
    await this.update((state) => { state.nextClientSequence = sequence + 1; });
    return sequence;
  }
  async operations() { return [...this.state.operations]; }
  async putOperation(operation: SyncOperation) {
    await this.update((state) => {
      const existing = state.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
      if (!existing) state.operations.push(operation);
      else if (JSON.stringify(existing) !== JSON.stringify(operation)) throw new Error('idempotency payload changed');
    });
  }
  async removeOperation(key: string) { await this.update((state) => { state.operations = state.operations.filter((item) => item.idempotencyKey !== key); }); }
  async putApplyIntent(intent: ClientApplyIntent) { await this.update((state) => { state.applyIntents = [...state.applyIntents.filter((item) => item.event.eventId !== intent.event.eventId), intent]; }); }
  async removeApplyIntent(eventId: string) { await this.update((state) => { state.applyIntents = state.applyIntents.filter((item) => item.event.eventId !== eventId); }); }
  async applyIntents() { return [...this.state.applyIntents]; }
  entryByPath(filePath: string) { return this.state.entries.find((entry) => !entry.deleted && entry.path === filePath) ?? null; }
  entryById(entryId: string) { return this.state.entries.find((entry) => entry.entryId === entryId) ?? null; }
  async putEntry(entry: SyncEntry) { await this.update((state) => { state.entries = [...state.entries.filter((item) => item.entryId !== entry.entryId), entry]; }); }
  async replaceEntries(entries: SyncEntry[]) { await this.update((state) => { state.entries = entries; }); }
  async queuePath(pending: PendingPath) { await this.update((state) => { state.pendingPaths = [...state.pendingPaths.filter((item) => item.path !== pending.path), pending]; }); }
  async removePendingPath(filePath: string) { await this.update((state) => { state.pendingPaths = state.pendingPaths.filter((item) => item.path !== filePath); }); }
  mergedSource(filePath: string) { return this.state.mergedSources[filePath]; }
  async putMergedSource(filePath: string, hash: string) { await this.update((state) => { state.mergedSources[filePath] = hash; }); }
  async removeMergedSource(filePath: string) { await this.update((state) => { delete state.mergedSources[filePath]; }); }

  private async read(): Promise<HeadlessState | null> {
    try {
      const envelope = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as Envelope;
      if (envelope.envelopeVersion !== 1 || envelope.checksum !== sha256Text(canonical(envelope.payload))) throw new Error('state checksum mismatch');
      if (envelope.payload.schemaVersion !== 1) throw new Error('unsupported state schema');
      // Additive schema-v1 migration: old states predate crash-safe clean-merge source markers.
      envelope.payload.mergedSources ??= {};
      return envelope.payload;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

async function atomicWrite(file: string, payload: HeadlessState): Promise<void> {
  const envelope: Envelope = { envelopeVersion: 1, checksum: sha256Text(canonical(payload)), payload };
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file); await fs.chmod(file, 0o600);
  const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

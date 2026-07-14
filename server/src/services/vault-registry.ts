import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { VaultStateStore } from '../sync/vault-state.js';
import {
  VaultRecordSchema,
  getPersistedSettings,
  updateVaultRegistry,
  type VaultRecord,
} from './settings.js';
import { runInVault, type VaultContext } from './vault-context.js';

export function vaultDataDir(vaultId: string, storage: VaultRecord['storage']): string {
  return storage === 'legacy' ? config.dataDir : path.join(config.dataDir, 'vaults', vaultId);
}

export async function vaultContext(vaultId?: string): Promise<VaultContext> {
  const settings = await getPersistedSettings();
  const selectedId = vaultId || settings.vaults.defaultVaultId;
  const record = settings.vaults.items.find((item) => item.id === selectedId);
  if (!record) throw Object.assign(new Error('Unknown vault'), { status: 404, code: 'vault_not_found' });
  return {
    vaultId: record.id,
    root: path.resolve(record.path),
    dataDir: vaultDataDir(record.id, record.storage),
    isDefault: record.id === settings.vaults.defaultVaultId,
  };
}

export async function selectedVaultMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const globalRoute = req.path.startsWith('/auth/') || req.path === '/healthz'
      || req.path.startsWith('/api/vaults') || req.path.startsWith('/public/') || req.path.startsWith('/share/');
    const header = req.headers['x-webobsidian-vault-id'];
    const query = typeof req.query.vaultId === 'string' ? req.query.vaultId : undefined;
    const requested = globalRoute ? undefined : (typeof header === 'string' && header ? header : query);
    const context = await vaultContext(requested);
    res.setHeader('X-WebObsidian-Vault-Id', context.vaultId);
    runInVault(context, next);
  } catch (error) {
    next(error);
  }
}

interface VaultLifecycleHandlers {
  registered: (record: VaultRecord) => Promise<void>;
  unregistering: (record: VaultRecord) => Promise<void>;
}
const lifecycle: VaultLifecycleHandlers = { registered: async () => {}, unregistering: async () => {} };
let registryLane: Promise<void> = Promise.resolve();

function serializeRegistry<T>(operation: () => Promise<T>): Promise<T> {
  const result = registryLane.then(operation, operation);
  registryLane = result.then(() => undefined, () => undefined);
  return result;
}

export function registerVaultLifecycleHandlers(handlers: Partial<VaultLifecycleHandlers>): void {
  if (handlers.registered) lifecycle.registered = handlers.registered;
  if (handlers.unregistering) lifecycle.unregistering = handlers.unregistering;
}

export async function validateRegisteredVaultRoots(records: VaultRecord[]): Promise<void> {
  const seen: Array<{ id: string; real: string; dev: bigint; ino: bigint }> = [];
  for (const record of records) {
    const stat = await fs.lstat(record.path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Registered vault ${record.id} is not a real directory`);
    const real = await fs.realpath(record.path);
    const identity = await fs.stat(real, { bigint: true });
    for (const prior of seen) {
      if ((identity.dev === prior.dev && identity.ino === prior.ino) || isInside(real, prior.real) || isInside(prior.real, real)) {
        throw new Error(`Registered vault roots overlap: ${prior.id} and ${record.id}`);
      }
    }
    seen.push({ id: record.id, real, dev: identity.dev, ino: identity.ino });
  }
}

export interface RegisterVaultInput {
  name: string;
  path: string;
  allowedRoots?: string[];
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function validatedRealRoot(inputPath: string, allowedRoots: string[], existing: VaultRecord[]): Promise<string> {
  const absolute = path.resolve(inputPath);
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw Object.assign(new Error('Vault path must be an existing non-symlink directory'), { status: 400 });
  }
  const real = await fs.realpath(absolute);
  const identity = await fs.stat(real, { bigint: true });
  const resolvedAllowed = await Promise.all(allowedRoots.map(async (root) => fs.realpath(path.resolve(root)).catch(() => path.resolve(root))));
  if (!resolvedAllowed.some((root) => isInside(real, root))) {
    throw Object.assign(new Error('Vault path is outside the allowed roots'), { status: 403 });
  }
  for (const item of existing) {
    const other = await fs.realpath(path.resolve(item.path)).catch(() => path.resolve(item.path));
    const otherIdentity = await fs.stat(other, { bigint: true }).catch(() => null);
    if ((otherIdentity && identity.dev === otherIdentity.dev && identity.ino === otherIdentity.ino)
      || isInside(real, other) || isInside(other, real)) {
      throw Object.assign(new Error('Vault roots may not overlap'), { status: 409, code: 'vault_root_overlap' });
    }
  }
  return real;
}

async function effectiveAllowedRoots(input: string[] | undefined, records: VaultRecord[]): Promise<string[]> {
  const configuredInput = config.allowedRoots.length
    ? config.allowedRoots
    : [...new Set(records.flatMap((item) => item.allowedRoots))];
  const configured = await Promise.all(configuredInput.map(async (root) => fs.realpath(path.resolve(root)).catch(() => path.resolve(root))));
  if (!input?.length) return configured;
  const requested = await Promise.all(input.map(async (root) => fs.realpath(path.resolve(root)).catch(() => path.resolve(root))));
  const outside = requested.some((root) => !configured.some((allowed) => isInside(root, allowed)));
  if (outside) throw Object.assign(new Error('Allowed roots cannot exceed the server allowlist'), { status: 403 });
  return requested;
}

export function registerVault(input: RegisterVaultInput): Promise<VaultRecord> {
  return serializeRegistry(() => registerVaultInternal(input));
}

async function registerVaultInternal(input: RegisterVaultInput): Promise<VaultRecord> {
  const settings = await getPersistedSettings();
  const allowedRoots = await effectiveAllowedRoots(input.allowedRoots, [...settings.vaults.items, ...settings.vaults.detached]);
  if (!allowedRoots.length) throw Object.assign(new Error('No allowed roots are configured'), { status: 403 });
  const root = await validatedRealRoot(input.path, allowedRoots, settings.vaults.items);
  const detached = await (async () => {
    for (const item of settings.vaults.detached) {
      const priorRoot = await fs.realpath(item.path).catch(() => path.resolve(item.path));
      if (priorRoot === root) return item;
    }
    return undefined;
  })();
  if (detached) {
    const restored = VaultRecordSchema.parse({ ...detached, name: input.name, path: root, allowedRoots });
    await updateVaultRegistry((draft) => {
      draft.vaults.detached = draft.vaults.detached.filter((item) => item.id !== restored.id);
      draft.vaults.items.push(restored);
    });
    try { await lifecycle.registered(restored); }
    catch (error) {
      await updateVaultRegistry((draft) => {
        draft.vaults.items = draft.vaults.items.filter((item) => item.id !== restored.id);
        draft.vaults.detached.push(restored);
      });
      throw error;
    }
    return restored;
  }
  const id = `vault_${randomBytes(18).toString('base64url')}`;
  const dataDir = vaultDataDir(id, 'isolated');
  const state = await new VaultStateStore(dataDir, id).loadOrCreate();
  const entries = await fs.readdir(root);
  const hasExistingContent = entries.some((entry) => !['.git', '.obsidian', '.trash'].includes(entry));
  const record = VaultRecordSchema.parse({
    id: state.vaultId, name: input.name, storage: 'isolated', path: root, allowedRoots,
    ...(hasExistingContent ? {
      sync: { enabled: false, bootstrapState: 'backup-required' },
      git: { mode: 'legacy-bidirectional' },
    } : {}),
  });
  await updateVaultRegistry((draft) => { draft.vaults.items.push(record); });
  try {
    await lifecycle.registered(record);
  } catch (error) {
    await updateVaultRegistry((draft) => { draft.vaults.items = draft.vaults.items.filter((item) => item.id !== record.id); });
    throw error;
  }
  return record;
}

export function renameVault(vaultId: string, name: string): Promise<VaultRecord> {
  return serializeRegistry(async () => {
    let updated: VaultRecord | undefined;
    await updateVaultRegistry((draft) => {
      const item = draft.vaults.items.find((candidate) => candidate.id === vaultId);
      if (!item) throw Object.assign(new Error('Unknown vault'), { status: 404 });
      item.name = name.trim();
      updated = VaultRecordSchema.parse(item);
    });
    return updated!;
  });
}

export function setDefaultVault(vaultId: string): Promise<void> {
  return serializeRegistry(async () => {
    await updateVaultRegistry((draft) => {
      if (!draft.vaults.items.some((item) => item.id === vaultId)) throw Object.assign(new Error('Unknown vault'), { status: 404 });
      draft.vaults.defaultVaultId = vaultId;
    });
  });
}

export function unregisterVault(vaultId: string): Promise<VaultRecord> {
  return serializeRegistry(() => unregisterVaultInternal(vaultId));
}

async function unregisterVaultInternal(vaultId: string): Promise<VaultRecord> {
  const current = await getPersistedSettings();
  if (current.vaults.items.length <= 1) throw Object.assign(new Error('Cannot unregister the last vault'), { status: 409 });
  if (current.vaults.defaultVaultId === vaultId) throw Object.assign(new Error('Choose another default vault before unregistering this vault'), { status: 409 });
  const removed = current.vaults.items.find((item) => item.id === vaultId);
  if (!removed) throw Object.assign(new Error('Unknown vault'), { status: 404 });
  await lifecycle.unregistering(removed);
  try {
    await updateVaultRegistry((draft) => {
      draft.vaults.items = draft.vaults.items.filter((item) => item.id !== vaultId);
      draft.vaults.detached.push(removed);
    });
  } catch (error) {
    await lifecycle.registered(removed).catch(() => {});
    throw error;
  }
  return removed;
}

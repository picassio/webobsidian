import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config, SETTINGS_FILE } from '../config.js';
import { VaultStateStore } from '../sync/vault-state.js';
import { currentVaultId } from './vault-context.js';

/** ---- Schema (PRD §6) ---------------------------------------------------- */

const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  hash: z.string(),
  prefix: z.string(),
  scopes: z.array(z.enum(['read', 'write', 'search'])).default(['read', 'search']),
  vaultIds: z.union([z.literal('*'), z.array(z.string())]).optional(),
  createdAt: z.string(),
  lastUsed: z.string().nullable().default(null),
});

const VaultFsSchema = z.object({
  path: z.string().default(''),
  allowedRoots: z.array(z.string()).default([]),
  trash: z.string().default('.trash'),
  deleteMode: z.enum(['trash', 'permanent']).default('trash'),
  attachmentDir: z.string().default('attachments'),
});

const SyncSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  bootstrapState: z.enum(['backup-required', 'ready']).default('ready'),
});

const GitSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['legacy-bidirectional', 'backup-only']).default('backup-only'),
  remote: z.string().default(''),
  branch: z.string().default('main'),
  token: z.string().default(''),
  authorName: z.string().default('WebObsidian'),
  authorEmail: z.string().default('webobsidian@localhost'),
  autoSync: z.boolean().default(false),
  autoCommitOnSave: z.boolean().default(false),
  intervalSec: z.number().default(300),
  lfsPatterns: z.array(z.string()).default(['*.png', '*.jpg', '*.jpeg', '*.gif', '*.pdf', '*.mp4', '*.mov', '*.zip']),
});

const PluginSettingsSchema = z.object({
  enabled: z.array(z.string()).default([]),
  installed: z.array(z.string()).default([]),
});

export const VaultRecordSchema = VaultFsSchema.extend({
  id: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(128),
  storage: z.enum(['legacy', 'isolated']).default('isolated'),
  sync: SyncSettingsSchema.default({}),
  git: GitSettingsSchema.default({}),
  plugins: PluginSettingsSchema.default({}),
});
export type VaultRecord = z.infer<typeof VaultRecordSchema>;

const VaultRegistrySchema = z.object({
  defaultVaultId: z.string(),
  items: z.array(VaultRecordSchema).min(1),
  detached: z.array(VaultRecordSchema).default([]),
}).superRefine((registry, ctx) => {
  const ids = new Set<string>();
  for (const [index, item] of [...registry.items, ...registry.detached].entries()) {
    if (ids.has(item.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'id'], message: 'Duplicate vault id' });
    ids.add(item.id);
  }
  if (!ids.has(registry.defaultVaultId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultVaultId'], message: 'Default vault is not registered' });
  }
});

const SettingsSchema = z.object({
  version: z.literal(4).default(4),
  auth: z.object({
    userPasswordHash: z.string().default(''),
    passwordHash: z.string().default(''),
    jwtSecret: z.string().default(''),
  }).default({}),
  vaults: VaultRegistrySchema,
  search: z.object({
    fuzzy: z.number().default(0.2),
    prefix: z.boolean().default(true),
    indexFrontmatter: z.boolean().default(true),
  }).default({}),
  api: z.object({
    keys: z.array(ApiKeySchema).default([]),
    rateLimitPerMin: z.number().default(120),
  }).default({}),
  ui: z.object({
    theme: z.enum(['obsidian-dark', 'obsidian-light']).default('obsidian-light'),
    defaultView: z.enum(['live', 'source', 'reading']).default('live'),
  }).default({}),
});

const LegacySettingsSchema = z.object({
  version: z.number().default(1),
  auth: z.object({ userPasswordHash: z.string().default(''), passwordHash: z.string().default(''), jwtSecret: z.string().default('') }).default({}),
  vault: VaultFsSchema.default({}),
  sync: SyncSettingsSchema.default({}),
  git: GitSettingsSchema.default({}),
  search: z.object({ fuzzy: z.number().default(0.2), prefix: z.boolean().default(true), indexFrontmatter: z.boolean().default(true) }).default({}),
  api: z.object({ keys: z.array(ApiKeySchema).default([]), rateLimitPerMin: z.number().default(120) }).default({}),
  ui: z.object({ theme: z.enum(['obsidian-dark', 'obsidian-light']).default('obsidian-light'), defaultView: z.enum(['live', 'source', 'reading']).default('live') }).default({}),
  plugins: PluginSettingsSchema.default({}),
});

export type PersistedSettings = z.infer<typeof SettingsSchema>;
export type ApiKeyRecord = z.infer<typeof ApiKeySchema>;
/** Compatibility projection used by existing vault-scoped services. */
export type Settings = PersistedSettings & {
  vault: z.infer<typeof VaultFsSchema>;
  sync: z.infer<typeof SyncSettingsSchema>;
  git: z.infer<typeof GitSettingsSchema>;
  plugins: z.infer<typeof PluginSettingsSchema>;
};

let cache: PersistedSettings | null = null;
let updateLane: Promise<void> = Promise.resolve();

function serializeUpdate<T>(operation: () => Promise<T>): Promise<T> {
  const result = updateLane.then(operation, operation);
  updateLane = result.then(() => undefined, () => undefined);
  return result;
}

function defaultVaultFs() {
  const vault = VaultFsSchema.parse({ path: config.defaultVaultPath });
  vault.allowedRoots = config.allowedRoots.length ? config.allowedRoots : [path.dirname(config.defaultVaultPath), config.defaultVaultPath];
  return vault;
}

async function defaults(): Promise<PersistedSettings> {
  const state = await new VaultStateStore(config.dataDir).loadOrCreate();
  const vault = defaultVaultFs();
  const record = VaultRecordSchema.parse({ id: state.vaultId, name: 'Default', storage: 'legacy', ...vault });
  const base = SettingsSchema.parse({ version: 4, vaults: { defaultVaultId: record.id, items: [record] } });
  base.auth.jwtSecret = randomBytes(48).toString('hex');
  return base;
}

function selectedRecord(settings: PersistedSettings, requested = currentVaultId()): VaultRecord {
  const id = requested ?? settings.vaults.defaultVaultId;
  return settings.vaults.items.find((item) => item.id === id)
    ?? settings.vaults.items.find((item) => item.id === settings.vaults.defaultVaultId)!;
}

function project(settings: PersistedSettings, requested = currentVaultId()): Settings {
  const item = selectedRecord(settings, requested);
  return {
    ...settings,
    vault: { path: item.path, allowedRoots: [...item.allowedRoots], trash: item.trash, deleteMode: item.deleteMode, attachmentDir: item.attachmentDir },
    sync: structuredClone(item.sync),
    git: structuredClone(item.git),
    plugins: structuredClone(item.plugins),
  };
}

export function ensureVaultBrowsable(d: Settings): boolean {
  const vaultPath = path.resolve(d.vault.path);
  const roots = d.vault.allowedRoots ?? [];
  const covered = roots.some((root) => {
    const resolved = path.resolve(root);
    return vaultPath === resolved || vaultPath.startsWith(`${resolved}${path.sep}`);
  });
  if (covered) return false;
  d.vault.allowedRoots = [...roots, path.dirname(vaultPath)];
  return true;
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
}

async function persist(settings: PersistedSettings): Promise<void> {
  await ensureDataDir();
  const json = JSON.stringify(settings, null, 2);
  const tmp = `${SETTINGS_FILE}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, json, { mode: 0o600 });
  try { await fs.copyFile(SETTINGS_FILE, `${SETTINGS_FILE}.bak`); } catch { /* first write */ }
  await fs.rename(tmp, SETTINGS_FILE);
}

async function preservePreV4Settings(sourceVersion: number, raw: string): Promise<void> {
  const backup = path.join(config.dataDir, `settings.v${sourceVersion}.pre-v4.json`);
  try {
    await fs.writeFile(backup, raw, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await fs.readFile(backup, 'utf8') !== raw) {
      throw new Error(`immutable pre-v4 settings backup already exists with different content: ${path.basename(backup)}`);
    }
  }
}

async function migrateLegacy(input: Record<string, unknown>): Promise<PersistedSettings> {
  const sourceVersion = Number(input.version ?? 1);
  const legacyInput = structuredClone(input);
  if (sourceVersion < 2) {
    const priorGit = legacyInput.git && typeof legacyInput.git === 'object' ? legacyInput.git as Record<string, unknown> : {};
    legacyInput.sync = { enabled: false, bootstrapState: 'backup-required' };
    legacyInput.git = { ...priorGit, mode: 'legacy-bidirectional' };
  } else if (sourceVersion === 2) {
    const priorSync = legacyInput.sync && typeof legacyInput.sync === 'object' ? legacyInput.sync as Record<string, unknown> : {};
    legacyInput.sync = { ...priorSync, bootstrapState: priorSync.enabled === false ? 'backup-required' : 'ready' };
  }
  const legacy = LegacySettingsSchema.parse(legacyInput);
  if (!legacy.vault.path) legacy.vault.path = config.defaultVaultPath;
  if (!legacy.vault.allowedRoots.length) legacy.vault.allowedRoots = defaultVaultFs().allowedRoots;
  if (legacy.auth.passwordHash && !legacy.auth.userPasswordHash) {
    legacy.auth.userPasswordHash = legacy.auth.passwordHash;
    legacy.auth.passwordHash = '';
  }
  if (!legacy.auth.jwtSecret) legacy.auth.jwtSecret = randomBytes(48).toString('hex');
  const state = await new VaultStateStore(config.dataDir).loadOrCreate();
  const record = VaultRecordSchema.parse({
    id: state.vaultId,
    name: 'Default',
    storage: 'legacy',
    ...legacy.vault,
    sync: legacy.sync,
    git: legacy.git,
    plugins: legacy.plugins,
  });
  return SettingsSchema.parse({
    version: 4,
    auth: legacy.auth,
    vaults: { defaultVaultId: record.id, items: [record] },
    search: legacy.search,
    api: {
      ...legacy.api,
      keys: legacy.api.keys.map((key) => ({ ...key, vaultIds: key.vaultIds ?? [record.id] })),
    },
    ui: legacy.ui,
  });
}

export async function loadSettings(): Promise<Settings> {
  if (cache) return project(cache);
  await ensureDataDir();
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const input = JSON.parse(raw) as Record<string, unknown>;
    const sourceVersion = Number(input.version ?? 1);
    if (!Number.isInteger(sourceVersion) || sourceVersion < 1 || sourceVersion > 4) {
      throw new Error(`unsupported settings version: ${String(input.version)}`);
    }
    let parsed: PersistedSettings;
    let dirty = false;
    if (sourceVersion === 4) parsed = SettingsSchema.parse(input);
    else {
      parsed = await migrateLegacy(input);
      await preservePreV4Settings(sourceVersion, raw);
      dirty = true;
    }
    if (!parsed.auth.jwtSecret) {
      parsed.auth.jwtSecret = randomBytes(48).toString('hex');
      dirty = true;
    }
    cache = parsed;
    if (dirty) await persist(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`settings.json is invalid; refusing to replace it: ${error instanceof Error ? error.message : String(error)}`);
    }
    cache = await defaults();
    const record = selectedRecord(cache);
    const entries = await fs.readdir(record.path).catch((readError: NodeJS.ErrnoException) => {
      if (readError.code === 'ENOENT') return [] as string[];
      throw readError;
    });
    const existingVault = entries.some((entry) => !['.git', '.obsidian', '.trash'].includes(entry));
    if (existingVault) {
      record.sync.enabled = false;
      record.sync.bootstrapState = 'backup-required';
      record.git.mode = 'legacy-bidirectional';
    }
    await persist(cache);
  }
  return project(cache);
}

export async function getPersistedSettings(): Promise<PersistedSettings> {
  if (!cache) await loadSettings();
  return structuredClone(cache!);
}

export async function getSettings(): Promise<Settings> {
  if (!cache) await loadSettings();
  return project(cache!);
}

export async function getVaultRecord(vaultId = currentVaultId()): Promise<VaultRecord> {
  if (!cache) await loadSettings();
  const item = selectedRecord(cache!, vaultId);
  return structuredClone(item);
}

export function updateSettings(mutator: (draft: Settings) => void | Promise<void>): Promise<Settings> {
  return serializeUpdate(async () => {
    if (!cache) await loadSettings();
    const selectedId = currentVaultId() ?? cache!.vaults.defaultVaultId;
    const draft = structuredClone(project(cache!, selectedId));
    await mutator(draft);
    const index = draft.vaults.items.findIndex((item) => item.id === selectedId);
    if (index < 0) throw new Error('Selected vault is no longer registered');
    draft.vaults.items[index] = VaultRecordSchema.parse({
      ...draft.vaults.items[index],
      ...draft.vault,
      sync: draft.sync,
      git: draft.git,
      plugins: draft.plugins,
    });
    const validated = SettingsSchema.parse(draft);
    await persist(validated);
    cache = validated;
    return project(validated, selectedId);
  });
}

export function updateVaultRegistry(
  mutator: (draft: PersistedSettings) => void | Promise<void>,
): Promise<PersistedSettings> {
  return serializeUpdate(async () => {
    if (!cache) await loadSettings();
    const draft = structuredClone(cache!);
    await mutator(draft);
    const validated = SettingsSchema.parse(draft);
    await persist(validated);
    cache = validated;
    return structuredClone(validated);
  });
}

function redactVault(item: VaultRecord) {
  return { ...item, git: { ...item.git, token: item.git.token ? '••••••••' : '' } };
}

export function redactSettings(settings: Settings) {
  return {
    ...settings,
    auth: {
      hasCustomPassword: Boolean(settings.auth.userPasswordHash),
      hasOverridePassword: Boolean(settings.auth.passwordHash),
    },
    vaults: {
      ...settings.vaults,
      items: settings.vaults.items.map(redactVault),
      detached: settings.vaults.detached.map(redactVault),
    },
    git: { ...settings.git, token: settings.git.token ? '••••••••' : '' },
    api: {
      ...settings.api,
      keys: settings.api.keys.map((key) => ({
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        scopes: key.scopes,
        vaultIds: key.vaultIds,
        createdAt: key.createdAt,
        lastUsed: key.lastUsed,
      })),
    },
  };
}

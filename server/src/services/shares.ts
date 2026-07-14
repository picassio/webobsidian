import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { currentVaultContext, currentVaultId, runInVault, type VaultContext } from './vault-context.js';
import { getPersistedSettings } from './settings.js';
import { vaultDataDir } from './vault-registry.js';

/** Public share links (FR-10) — persisted as a JSON array in data/shares.json. */
export interface ShareRecord {
  id: string;
  path: string; // vault-relative note path
  enabled: boolean;
  createdAt: string;
  /** Optional scrypt hash — set when the share is password-protected. */
  passwordHash?: string;
}

const caches = new Map<string, ShareRecord[]>();
function cacheKey(): string { return currentVaultId() ?? '__default__'; }
function sharesFile(): string { return path.join(currentVaultContext()?.dataDir ?? config.dataDir, 'shares.json'); }

async function load(): Promise<ShareRecord[]> {
  const key = cacheKey();
  const cached = caches.get(key);
  if (cached) return cached;
  try {
    const raw = await fs.readFile(sharesFile(), 'utf8');
    const parsed = JSON.parse(raw);
    const loaded = Array.isArray(parsed)
      ? parsed.filter(
          (r): r is ShareRecord =>
            r && typeof r.id === 'string' && typeof r.path === 'string',
        )
      : [];
    caches.set(key, loaded);
  } catch {
    caches.set(key, []);
  }
  return caches.get(key)!;
}

/** Atomic write: tmp + rename (same pattern as settings.json). */
async function persist(shares: ShareRecord[]): Promise<void> {
  const file = sharesFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(shares, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  caches.set(cacheKey(), shares);
}

export async function listShares(): Promise<ShareRecord[]> {
  return [...(await load())];
}

/** Look up an ENABLED share by token (used by the public route). */
export async function getActiveShare(id: string): Promise<ShareRecord | null> {
  const shares = await load();
  return shares.find((s) => s.id === id && s.enabled) ?? null;
}

export async function findActiveShareVault(id: string): Promise<{ share: ShareRecord; context: VaultContext } | null> {
  const settings = await getPersistedSettings();
  for (const item of settings.vaults.items) {
    const context: VaultContext = {
      vaultId: item.id,
      root: item.path,
      dataDir: vaultDataDir(item.id, item.storage),
      isDefault: item.id === settings.vaults.defaultVaultId,
    };
    const share = await runInVault(context, () => getActiveShare(id));
    if (share) return { share, context };
  }
  return null;
}

/**
 * Create a share for a note. One record per note: if the note already has a
 * share, re-enable and return it (keeps the existing public URL stable).
 */
export async function createShare(relPath: string): Promise<ShareRecord> {
  const shares = await load();
  const existing = shares.find((s) => s.path === relPath);
  if (existing) {
    if (!existing.enabled) {
      existing.enabled = true;
      await persist(shares);
    }
    return existing;
  }
  const record: ShareRecord = {
    id: randomBytes(16).toString('base64url'),
    path: relPath,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  shares.push(record);
  await persist(shares);
  return record;
}

export async function setShareEnabled(id: string, enabled: boolean): Promise<ShareRecord | null> {
  const shares = await load();
  const rec = shares.find((s) => s.id === id);
  if (!rec) return null;
  if (rec.enabled !== enabled) {
    rec.enabled = enabled;
    await persist(shares);
  }
  return rec;
}

/** Set (hash) or clear (null) the password of a share. */
export async function setSharePassword(id: string, passwordHash: string | null): Promise<ShareRecord | null> {
  const shares = await load();
  const rec = shares.find((s) => s.id === id);
  if (!rec) return null;
  if (passwordHash) rec.passwordHash = passwordHash;
  else delete rec.passwordHash;
  await persist(shares);
  return rec;
}

export async function deleteShare(id: string): Promise<boolean> {
  const shares = await load();
  const next = shares.filter((s) => s.id !== id);
  if (next.length === shares.length) return false;
  caches.set(cacheKey(), next);
  await persist(next);
  return true;
}

/** Keep share paths in sync when notes are renamed/deleted elsewhere. */
export async function onFileRenamed(from: string, to: string): Promise<void> {
  const shares = await load();
  const rec = shares.find((s) => s.path === from);
  if (rec) {
    rec.path = to;
    await persist(shares);
  }
}

import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { requireSyncAdminCsrf } from '../middleware/sync-rate-limit.js';
import { getPersistedSettings } from '../services/settings.js';
import { registerVault, renameVault, setDefaultVault, unregisterVault, vaultDataDir } from '../services/vault-registry.js';
import { getSyncRuntime } from '../services/sync-runtime.js';

export const vaultsRouter = Router();
vaultsRouter.use(requireAuth);

vaultsRouter.get('/', asyncHandler(async (_req, res) => {
  const settings = await getPersistedSettings();
  res.json({
    defaultVaultId: settings.vaults.defaultVaultId,
    vaults: settings.vaults.items.map((item) => ({
      id: item.id,
      name: item.name,
      path: item.path,
      storage: item.storage,
      isDefault: item.id === settings.vaults.defaultVaultId,
      sync: item.sync,
      dataDir: vaultDataDir(item.id, item.storage),
      health: getSyncRuntime(item.id).coordinator.health(),
    })),
  });
}));

vaultsRouter.post('/', requireSyncAdminCsrf, asyncHandler(async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const vaultPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
  const allowedRoots = Array.isArray(req.body?.allowedRoots)
    ? req.body.allowedRoots.filter((root: unknown): root is string => typeof root === 'string')
    : undefined;
  if (!name || name.length > 128 || !vaultPath) return res.status(400).json({ error: 'Valid name and path are required' });
  const vault = await registerVault({ name, path: vaultPath, allowedRoots });
  res.status(201).json({ vault: { ...vault, git: { ...vault.git, token: vault.git.token ? '••••••••' : '' } } });
}));

vaultsRouter.patch('/:vaultId', requireSyncAdminCsrf, asyncHandler(async (req, res) => {
  let vault;
  if (req.body?.name !== undefined) {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 128) return res.status(400).json({ error: 'Valid vault name is required' });
    vault = await renameVault(req.params.vaultId, name);
  }
  if (req.body?.default === true) await setDefaultVault(req.params.vaultId);
  if (!vault && req.body?.default !== true) return res.status(400).json({ error: 'No supported vault update supplied' });
  res.json({ ok: true, ...(vault ? { vault } : {}) });
}));

vaultsRouter.delete('/:vaultId', requireSyncAdminCsrf, asyncHandler(async (req, res) => {
  if (req.body?.confirm !== req.params.vaultId) {
    return res.status(400).json({ error: 'Vault id confirmation is required; files will not be deleted' });
  }
  const removed = await unregisterVault(req.params.vaultId);
  res.json({ ok: true, removed: { id: removed.id, name: removed.name, path: removed.path }, filesDeleted: false });
}));

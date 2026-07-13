import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import * as git from '../services/git.js';
import { getSyncCoordinator } from '../services/sync-runtime.js';
import { getSettings, updateSettings } from '../services/settings.js';

export const gitRouter = Router();
gitRouter.use(requireAuth);
let gitImportClientSequence = Date.now() * 1000;

gitRouter.get('/status', asyncHandler(async (_req, res) => res.json(await git.status())));

gitRouter.get(
  '/log',
  asyncHandler(async (req, res) => {
    const path = String(req.query.path ?? '').trim();
    if (!path) return res.status(400).json({ error: 'path required' });
    res.json({ commits: await git.log(path) });
  }),
);

gitRouter.get(
  '/show',
  asyncHandler(async (req, res) => {
    const hash = String(req.query.hash ?? '').trim();
    const path = String(req.query.path ?? '').trim();
    if (!hash || !path) return res.status(400).json({ error: 'hash and path required' });
    res.json({ content: await git.showFile(hash, path) });
  }),
);

gitRouter.post(
  '/init',
  asyncHandler(async (_req, res) => {
    await git.init();
    res.json(await git.status());
  }),
);

gitRouter.post(
  '/clone',
  asyncHandler(async (_req, res) => {
    await git.clone();
    await getSyncCoordinator().reconcileExternalDrift();
    res.json(await git.status());
  }),
);

gitRouter.post(
  '/import',
  asyncHandler(async (req, res) => {
    const imported = await git.cloneForImport();
    try {
      const coordinator = getSyncCoordinator();
      const deleteMissing = req.body?.deleteMissing === true;
      const plan = await coordinator.planDirectoryImport(imported.directory, deleteMissing);
      if (req.body?.confirm !== true) {
        res.json({ dryRun: true, plan });
        return;
      }
      const result = await coordinator.importDirectory(
        imported.directory,
        deleteMissing,
        { type: 'git-import', id: 'git_import_admin_1' },
        () => {
          gitImportClientSequence = Math.max(gitImportClientSequence + 1, Date.now() * 1000);
          return {
            clientSequence: gitImportClientSequence,
            idempotencyKey: `git-import:${gitImportClientSequence}`,
          };
        },
      );
      res.json({ dryRun: false, ...result });
    } finally {
      await imported.cleanup();
    }
  }),
);

gitRouter.get('/migration', asyncHandler(async (_req, res) => {
  const [settings, current] = await Promise.all([getSettings(), git.status()]);
  res.json({
    centralSyncEnabled: settings.sync.enabled,
    gitMode: settings.git.mode,
    backupRemoteConfigured: Boolean(settings.git.remote),
    ready: current.conflicted.length === 0,
    blockers: current.conflicted.map((file) => `unresolved Git conflict: ${file}`),
    status: current,
  });
}));

gitRouter.post('/migration', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const current = await git.status();
  if (current.conflicted.length > 0) return res.status(409).json({ error: 'Resolve legacy Git conflicts before migration', conflicts: current.conflicted });
  if (!settings.git.remote && req.body?.allowLocalOnlyBackup !== true) {
    return res.status(409).json({ error: 'A remote backup is not configured; explicitly allow a local-only backup to continue' });
  }
  if (req.body?.confirm !== true) return res.json({ dryRun: true, status: current, remoteConfigured: Boolean(settings.git.remote) });
  if (!current.isRepo) await git.init();
  const backup = [await git.commitAll('Pre-Central Sync migration backup')];
  if (settings.git.remote) backup.push(await git.push());
  const updated = await updateSettings((draft) => {
    draft.sync.enabled = true;
    draft.sync.bootstrapState = 'ready';
    draft.git.mode = 'backup-only';
  });
  res.json({ dryRun: false, centralSyncEnabled: updated.sync.enabled, gitMode: updated.git.mode, backup });
}));

gitRouter.post(
  '/pull',
  asyncHandler(async (_req, res) => {
    const message = await git.pull();
    await getSyncCoordinator().reconcileExternalDrift();
    console.log('[git] legacy pull:', message);
    res.json({ message });
  }),
);

gitRouter.post(
  '/commit',
  asyncHandler(async (req, res) => {
    const message = await git.commitAll(String(req.body?.message ?? ''));
    console.log('[git] commit:', message);
    res.json({ message });
  }),
);

gitRouter.post(
  '/push',
  asyncHandler(async (_req, res) => {
    const message = await git.push();
    console.log('[git] push:', message);
    res.json({ message });
  }),
);

gitRouter.post(
  '/sync',
  asyncHandler(async (req, res) => {
    console.log('[git] manual sync requested');
    const legacy = await git.isLegacyBidirectionalEnabled();
    const result = await git.sync(req.body?.message);
    if (legacy) await getSyncCoordinator().reconcileExternalDrift();
    console.log(`[git] ${legacy ? 'legacy sync' : 'backup'} ${result.ok ? 'ok' : 'not-ok'}:`, result.log.join(' | '));
    res.json(result);
  }),
);

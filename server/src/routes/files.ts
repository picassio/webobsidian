import { Router, type Request } from 'express';
import multer from 'multer';
import path from 'node:path';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import * as vault from '../services/vault.js';
import { getSettings } from '../services/settings.js';
import { resolveFile } from '../services/fileindex.js';
import { mimeFor } from '../services/mime.js';
import { sendFileWithRange } from '../services/httpfile.js';
import { getSyncBlobStore, getSyncCoordinator } from '../services/sync-runtime.js';
import { CoordinatorError, LEGACY_WEB_ACTOR } from '../sync/coordinator.js';
import { sha256Bytes, type OperationResult, type SyncEntry } from '@picassio/sync-core';

export const filesRouter = Router();
filesRouter.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } });

function resultEtag(result: OperationResult): string | undefined {
  return result.entryId && result.revision !== undefined && result.hash !== undefined
    ? `\"${result.entryId}:${result.revision}:${result.hash ?? 'directory'}\"`
    : undefined;
}

function requestedBaseRevision(req: Request, current: SyncEntry): number {
  const bodyRevision = typeof req.body?.baseRevision === 'string' ? Number(req.body.baseRevision) : req.body?.baseRevision;
  if (Number.isSafeInteger(bodyRevision) && bodyRevision >= 1) return bodyRevision;
  const match = String(req.headers['if-match'] ?? '').match(/:([0-9]+):/);
  if (match) return Number(match[1]);
  throw new CoordinatorError('revision_conflict', 'baseRevision or If-Match is required for an existing entry', {
    entryId: current.entryId, path: current.path, currentRevision: current.revision,
  });
}

async function applyLegacyFileWrite(rel: string, bytes: Buffer, req: Request): Promise<OperationResult> {
  const coordinator = getSyncCoordinator();
  const current = await coordinator.entryByPath(rel);
  const metadata = coordinator.nextLegacyOperationMetadata();
  const hash = sha256Bytes(bytes);
  await getSyncBlobStore().put([bytes], hash, bytes.byteLength);
  if (current) {
    return coordinator.apply({
      operation: 'modify', ...metadata, entryId: current.entryId,
      baseRevision: requestedBaseRevision(req, current),
      content: { hash, size: bytes.byteLength, blobHash: hash },
    }, LEGACY_WEB_ACTOR);
  }
  return coordinator.apply({
    operation: 'create', ...metadata, path: rel, kind: 'file',
    content: { hash, size: bytes.byteLength, blobHash: hash },
  }, LEGACY_WEB_ACTOR);
}

filesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await vault.listTree());
  }),
);

filesRouter.get(
  '/revision',
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel) return res.status(400).json({ error: 'path required' });
    const entry = await getSyncCoordinator().entryByPath(rel);
    if (!entry) return res.status(404).json({ error: 'entry not found' });
    res.json({ entryId: entry.entryId, path: entry.path, kind: entry.kind, revision: entry.revision, hash: entry.hash, size: entry.size });
  }),
);

filesRouter.get(
  '/content',
  asyncHandler(async (req, res) => {
    let rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    // Obsidian-style resolution: if the exact path doesn't exist (e.g. an embed
    // `![[image.jpg]]` that lives in Attachments/), resolve it by basename.
    if (!(await vault.exists(rel))) {
      const resolved = resolveFile(rel);
      if (resolved) rel = resolved;
    }
    const entry = await getSyncCoordinator().entryByPath(rel);
    if (entry) {
      res.setHeader('ETag', `\"${entry.entryId}:${entry.revision}:${entry.hash ?? 'directory'}\"`);
      res.setHeader('X-Entry-Id', entry.entryId);
      res.setHeader('X-Revision', String(entry.revision));
      if (entry.hash) res.setHeader('X-Content-SHA256', entry.hash);
    }
    if (vault.isTextFile(rel)) {
      res.json({
        path: rel,
        content: await vault.readFileText(rel),
        encoding: 'utf8',
        ...(entry ? { entryId: entry.entryId, revision: entry.revision, hash: entry.hash } : {}),
      });
    } else {
      // Stream with Range support so embedded <video>/<audio> can seek.
      const abs = await vault.resolveInVault(rel);
      await sendFileWithRange(req, res, abs, mimeFor(rel));
    }
  }),
);

filesRouter.put(
  '/content',
  asyncHandler(async (req, res) => {
    const { path: rel, content } = req.body ?? {};
    if (typeof rel !== 'string' || typeof content !== 'string') {
      res.status(400).json({ error: 'path and content required' });
      return;
    }
    const result = await applyLegacyFileWrite(rel, Buffer.from(content, 'utf8'), req);
    const etag = resultEtag(result);
    if (etag) res.setHeader('ETag', etag);
    res.json({ ok: true, path: result.path, ...result });
  }),
);

filesRouter.post(
  '/folder',
  asyncHandler(async (req, res) => {
    const { path: rel } = req.body ?? {};
    if (typeof rel !== 'string') {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const coordinator = getSyncCoordinator();
    const result = await coordinator.apply({
      operation: 'mkdir', ...coordinator.nextLegacyOperationMetadata(), path: rel, kind: 'directory',
    }, LEGACY_WEB_ACTOR);
    const etag = resultEtag(result);
    if (etag) res.setHeader('ETag', etag);
    res.json({ ok: true, path: result.path, ...result });
  }),
);

filesRouter.post(
  '/upload',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const dir = String(req.body?.dir ?? '');
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'file required' });
      return;
    }
    // Reuse an existing folder that differs only in case (e.g. an Obsidian vault's
    // "Attachments") instead of creating a duplicate "attachments". See vault.ts.
    const resolvedDir = dir ? await vault.resolveDirCaseInsensitive(dir) : '';
    const rel = path.posix.join(resolvedDir, file.originalname);
    const result = await applyLegacyFileWrite(rel, file.buffer, req);
    const etag = resultEtag(result);
    if (etag) res.setHeader('ETag', etag);
    res.json({ ok: true, path: result.path, size: file.size, ...result });
  }),
);

filesRouter.patch(
  '/rename',
  asyncHandler(async (req, res) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ error: 'from and to required' });
      return;
    }
    const coordinator = getSyncCoordinator();
    const current = await coordinator.entryByPath(from);
    if (!current) {
      res.status(404).json({ error: 'source not found' });
      return;
    }
    const result = await coordinator.apply({
      operation: 'rename', ...coordinator.nextLegacyOperationMetadata(),
      entryId: current.entryId, baseRevision: requestedBaseRevision(req, current), path: to,
    }, LEGACY_WEB_ACTOR);
    const etag = resultEtag(result);
    if (etag) res.setHeader('ETag', etag);
    res.json({ ok: true, from, to: result.path, ...result });
  }),
);

filesRouter.post(
  '/copy',
  asyncHandler(async (req, res) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ error: 'from and to required' });
      return;
    }
    const coordinator = getSyncCoordinator();
    const results = await coordinator.copyPath(
      from,
      to,
      LEGACY_WEB_ACTOR,
      () => coordinator.nextLegacyOperationMetadata(),
    );
    res.json({ ok: true, from, to, results });
  }),
);

// --- Trash (FR-1) -----------------------------------------------------------
// Listed/mutated via dedicated /trash* routes; the plain DELETE / below either
// trashes or permanently removes depending on settings.vault.deleteMode.

filesRouter.get(
  '/trash',
  asyncHandler(async (_req, res) => {
    const records = await getSyncCoordinator().listTrash();
    res.json({
      items: records.map((record) => ({
        name: path.posix.basename(record.originalPath),
        path: record.trashPath,
        original: record.originalPath,
        ext: path.posix.extname(record.originalPath).toLowerCase(),
        size: record.size,
        mtime: Date.parse(record.deletedAt),
      })),
    });
  }),
);

filesRouter.post(
  '/trash/restore',
  asyncHandler(async (req, res) => {
    const rel = String(req.body?.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const coordinator = getSyncCoordinator();
    const result = await coordinator.restoreTrash(rel, LEGACY_WEB_ACTOR, coordinator.nextLegacyOperationMetadata());
    res.json({ ok: true, restored: result.path, ...result });
  }),
);

// Permanently delete one trashed item.
filesRouter.delete(
  '/trash/item',
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    await getSyncCoordinator().purgeTrash(rel);
    res.json({ ok: true });
  }),
);

// Empty the whole trash.
filesRouter.delete(
  '/trash',
  asyncHandler(async (_req, res) => {
    await getSyncCoordinator().emptyTrash();
    res.json({ ok: true });
  }),
);

filesRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const s = await getSettings();
    const coordinator = getSyncCoordinator();
    const current = await coordinator.entryByPath(rel);
    if (!current) {
      res.status(404).json({ error: 'path not found' });
      return;
    }
    const result = await coordinator.apply({
      operation: current.kind === 'directory' ? 'rmdir' : 'delete',
      ...coordinator.nextLegacyOperationMetadata(),
      entryId: current.entryId,
      baseRevision: requestedBaseRevision(req, current),
    }, LEGACY_WEB_ACTOR);
    const record = (await coordinator.listTrash()).find((item) => item.entryId === current.entryId);
    if (s.vault.deleteMode === 'permanent' && record) await coordinator.purgeTrash(record.trashPath);
    res.json({
      ok: true,
      ...(s.vault.deleteMode === 'permanent' ? { deleted: rel } : { trashed: record?.trashPath ?? rel }),
      ...result,
    });
  }),
);

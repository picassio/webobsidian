import { Router, type Request } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireApiKey } from '../middleware/apikey.js';
import * as vault from '../services/vault.js';
import { qmd } from '../services/search.js';
import { backlinksFor } from '../services/links.js';
import { parseNote } from '../services/markdown.js';
import { getSyncBlobStore, getSyncCoordinator } from '../services/sync-runtime.js';
import { sha256Text, type SyncEvent } from '@webobsidian/sync-core';

/**
 * Agent API (PRD FR-6) — REST surface for AI agents, authenticated by API key.
 * All note paths are vault-relative. Scopes: read / write / search.
 */
export const agentRouter = Router();

function agentActor(req: Request): SyncEvent['actor'] {
  return { type: 'agent', id: `agent_${req.apiKey!.id}` };
}

function operationMetadata(req: Request) {
  if (!Number.isSafeInteger(req.body?.clientSequence) || req.body.clientSequence < 1 || typeof req.body?.idempotencyKey !== 'string') {
    throw Object.assign(new Error('positive clientSequence and idempotencyKey are required'), { status: 428 });
  }
  return { clientSequence: req.body.clientSequence as number, idempotencyKey: req.body.idempotencyKey as string };
}

function baseRevision(req: Request): number {
  if (Number.isSafeInteger(req.body?.baseRevision) && req.body.baseRevision >= 1) return req.body.baseRevision as number;
  throw Object.assign(new Error('baseRevision is required for an existing note'), { status: 428 });
}

async function writeNote(req: Request, rel: string, content: string) {
  const coordinator = getSyncCoordinator();
  const current = await coordinator.entryByPath(rel);
  const hash = sha256Text(content);
  const size = Buffer.byteLength(content);
  await getSyncBlobStore().put([Buffer.from(content)], hash, size);
  return current
    ? coordinator.apply({
        operation: 'modify', ...operationMetadata(req), entryId: current.entryId,
        baseRevision: baseRevision(req), content: { hash, size, blobHash: hash },
      }, agentActor(req))
    : coordinator.apply({
        operation: 'create', ...operationMetadata(req), path: rel, kind: 'file',
        content: { hash, size, blobHash: hash },
      }, agentActor(req));
}

agentRouter.get('/health', (_req, res) => res.json({ ok: true, service: 'webobsidian-agent-api', version: 'v1' }));

// List notes
agentRouter.get(
  '/notes',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const all = await vault.listMarkdownFiles();
    const offset = Number(req.query.offset ?? 0) || 0;
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    res.json({ total: all.length, offset, limit, notes: all.slice(offset, offset + limit) });
  }),
);

// Read a note (path can contain slashes)
agentRouter.get(
  '/notes/*',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const rel = decodeURIComponent((req.params as any)[0]);
    if (!(await vault.exists(rel))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const content = await vault.readFileText(rel);
    const note = parseNote(rel, content);
    const entry = await getSyncCoordinator().entryByPath(rel);
    if (entry) res.setHeader('ETag', `\"${entry.entryId}:${entry.revision}:${entry.hash ?? 'directory'}\"`);
    res.json({
      path: rel,
      content,
      ...(entry ? { entryId: entry.entryId, revision: entry.revision, hash: entry.hash } : {}),
      title: note.title,
      frontmatter: note.frontmatter,
      tags: note.tags,
      links: note.links,
    });
  }),
);

// Create / update a note
agentRouter.put(
  '/notes/*',
  requireApiKey('write'),
  asyncHandler(async (req, res) => {
    const rel = decodeURIComponent((req.params as any)[0]);
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const result = await writeNote(req, rel, content);
    res.json({ ok: true, path: result.path, ...result });
  }),
);

// Append to a note (creates if missing)
agentRouter.patch(
  '/notes/*',
  requireApiKey('write'),
  asyncHandler(async (req, res) => {
    const rel = decodeURIComponent((req.params as any)[0]);
    const append = typeof req.body?.append === 'string' ? req.body.append : '';
    const existing = (await vault.exists(rel)) ? await vault.readFileText(rel) : '';
    const joined = existing && !existing.endsWith('\n') ? existing + '\n' + append : existing + append;
    const result = await writeNote(req, rel, joined);
    res.json({ ok: true, path: result.path, size: Buffer.byteLength(joined), ...result });
  }),
);

// Delete a note (to trash)
agentRouter.delete(
  '/notes/*',
  requireApiKey('write'),
  asyncHandler(async (req, res) => {
    const rel = decodeURIComponent((req.params as any)[0]);
    if (!(await vault.exists(rel))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const coordinator = getSyncCoordinator();
    const current = await coordinator.entryByPath(rel);
    if (!current) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const result = await coordinator.apply({
      operation: current.kind === 'directory' ? 'rmdir' : 'delete',
      ...operationMetadata(req), entryId: current.entryId,
      baseRevision: baseRevision(req),
    }, agentActor(req));
    const trashed = (await coordinator.listTrash()).find((record) => record.entryId === current.entryId)?.trashPath;
    res.json({ ok: true, trashed, ...result });
  }),
);

// Search
agentRouter.get(
  '/search',
  requireApiKey('search'),
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '');
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    res.json({ query: q, hits: await qmd.search(q, limit) });
  }),
);

// Backlinks
agentRouter.get(
  '/backlinks',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    res.json({ path: rel, backlinks: backlinksFor(rel) });
  }),
);

// Tags
agentRouter.get(
  '/tags',
  requireApiKey('read'),
  asyncHandler(async (_req, res) => {
    res.json({ tags: qmd.allTags() });
  }),
);

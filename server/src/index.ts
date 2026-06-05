import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';

import { config } from './config.js';
import { loadSettings, getSettings, setPasswordIfInitial } from './bootstrap.js';
import { errorHandler } from './middleware/error.js';
import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { searchRouter } from './routes/search.js';
import { settingsRouter } from './routes/settings.js';
import { gitRouter } from './routes/git.js';
import { keysRouter } from './routes/keys.js';
import { pluginsRouter } from './routes/plugins.js';
import { agentRouter } from './routes/agent.js';
import { uiStateRouter } from './routes/uistate.js';
import { initSearch, qmd } from './services/search.js';
import { buildLinkGraph } from './services/links.js';
import { buildFileIndex, indexFile, unindexFile } from './services/fileindex.js';
import { setBroadcaster, broadcast } from './services/realtime.js';
import { getVaultRoot, ensureVault } from './services/vault.js';
import { startAutoSync } from './services/autosync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Keep the local server alive on stray async errors (e.g. a deferred library task
// throwing) instead of crashing the whole process — log loudly so bugs aren't hidden.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

async function main() {
  await loadSettings();
  await setPasswordIfInitial();
  await ensureVault();

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32mb' }));
  app.use(cookieParser());
  if (!config.isProd) {
    app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
  }

  // Health (no auth) — for docker healthcheck
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Routes. NOTE: specific /api/* routers must be registered BEFORE the broad
  // '/api' search router, whose router-level requireAuth middleware would
  // otherwise gate every /api/* path (incl. /api/v1 and /api/keys) by prefix.
  app.use('/auth', authRouter);
  app.use('/api/v1', agentRouter); // agent API (api-key auth)
  app.use('/api/files', filesRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/git', gitRouter);
  app.use('/api/keys', keysRouter);
  app.use('/api/plugins', pluginsRouter);
  app.use('/api/uistate', uiStateRouter);
  app.use('/api', searchRouter); // /api/search, /api/tags, /api/backlinks, /api/graph...

  // Static SPA (built into server/public)
  const publicDir = path.join(__dirname, '..', 'public');
  if (await dirExists(publicDir)) {
    app.use(express.static(publicDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return next();
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  app.use(errorHandler);

  // Build search index + link graph
  console.log('[boot] indexing vault...');
  await initSearch();
  await buildLinkGraph();
  await buildFileIndex();
  console.log('[boot] index ready');

  const server = http.createServer(app);
  setupWebsocket(server);
  await setupWatcher();
  startAutoSync();

  server.listen(config.port, config.host, () => {
    console.log(`\n  WebObsidian server → http://${config.host}:${config.port}`);
    console.log(`  Vault: ${config.defaultVaultPath}`);
    console.log(`  Data:  ${config.dataDir}\n`);
  });
}

// --- WebSocket: broadcast filesystem & UI-state events to connected clients ----
function setupWebsocket(server: http.Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello' }));
  });
  setBroadcaster((msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  });
}

// --- chokidar watcher: reflect external changes (git pull, direct edits) ---
async function setupWatcher() {
  const root = await getVaultRoot();
  const watcher = chokidar.watch(root, {
    ignored: (p) => /(^|[/\\])(\.git|node_modules|\.trash)([/\\]|$)/.test(p),
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  // Rebuilding the link graph reads every markdown file, so coalesce bursts of
  // filesystem events (e.g. a git pull touching thousands of files) into one
  // rebuild instead of one per file — otherwise large vaults exhaust memory.
  let linkTimer: NodeJS.Timeout | null = null;
  const scheduleLinkRebuild = () => {
    if (linkTimer) clearTimeout(linkTimer);
    linkTimer = setTimeout(() => void buildLinkGraph().catch(() => {}), 1500);
  };

  const onChange = async (absPath: string, type: string) => {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    // keep the attachment/file index in sync for embed resolution
    if (type === 'add') indexFile(rel);
    else if (type === 'unlink') unindexFile(rel);
    if (/\.(md|markdown)$/i.test(rel)) {
      if (type === 'unlink') qmd.remove(rel);
      else await qmd.upsert(rel).catch(() => {});
      scheduleLinkRebuild();
    }
    broadcast({ type: 'fs', event: type, path: rel });
  };
  watcher
    .on('add', (p) => onChange(p, 'add'))
    .on('change', (p) => onChange(p, 'change'))
    .on('unlink', (p) => onChange(p, 'unlink'))
    .on('addDir', (p) => onChange(p, 'addDir'))
    .on('unlinkDir', (p) => onChange(p, 'unlinkDir'));
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

import express, { type Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, promises as fs, type Stats } from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';

import { config } from './config.js';
import { loadSettings, getSettings, setPasswordIfInitial } from './bootstrap.js';
import { asyncHandler, errorHandler } from './middleware/error.js';
import { COOKIE_NAME } from './middleware/auth.js';
import { verifyToken } from './services/auth.js';
import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { searchRouter } from './routes/search.js';
import { settingsRouter } from './routes/settings.js';
import { gitRouter } from './routes/git.js';
import { keysRouter } from './routes/keys.js';
import { pluginsRouter } from './routes/plugins.js';
import { agentRouter } from './routes/agent.js';
import { uiStateRouter } from './routes/uistate.js';
import { syncRouter } from './routes/sync.js';
import { vaultsRouter } from './routes/vaults.js';
import { sharesRouter, publicSharesRouter } from './routes/shares.js';
import { sharePageRouter } from './routes/sharepage.js';
import { initSearch, qmd } from './services/search.js';
import { buildLinkGraph, updateLinkGraphForFile } from './services/links.js';
import { buildFileIndex, indexFile, unindexFile } from './services/fileindex.js';
import { setBroadcaster, broadcast } from './services/realtime.js';
import { invalidateStat } from './services/vault.js';
import { startAutoSync, stopAutoSync } from './services/autosync.js';
import { scheduleAutoCommitOnSave } from './services/git.js';
import { onFileRenamed } from './services/shares.js';
import {
  addSyncRuntime, beginSyncRuntimeDrain, cancelSyncRuntimeDrain, getSyncCoordinator, getSyncRuntime,
  initializeSyncRuntimes, leaseSyncRuntime, listSyncRuntimes, removeSyncRuntime, shutdownSyncRuntime,
  waitForSyncRuntimeDrain,
} from './services/sync-runtime.js';
import { disconnectSyncWebSockets, registerSyncWebSocketDisconnect } from './sync/ws-registry.js';
import { sha256Chunks, type SyncEvent } from '@picassio/sync-core';
import { wsTickets } from './sync/ws-tickets.js';
import { registerVaultLifecycleHandlers, selectedVaultMiddleware, validateRegisteredVaultRoots, vaultContext } from './services/vault-registry.js';
import { getPersistedSettings } from './services/settings.js';
import { runInVault, type VaultContext } from './services/vault-context.js';

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
  const persistedSettings = await getPersistedSettings();
  for (const record of persistedSettings.vaults.items) await fs.mkdir(record.path, { recursive: true });
  await validateRegisteredVaultRoots(persistedSettings.vaults.items);
  const syncRuntimes = await initializeSyncRuntimes(persistedSettings.vaults.items, persistedSettings.vaults.defaultVaultId);
  registerVaultLifecycleHandlers({
    registered: async (record) => {
      const settings = await getPersistedSettings();
      const runtime = await addSyncRuntime(record, settings.vaults.defaultVaultId);
      try { await initializeVaultServices(runtime); }
      catch (error) {
        beginSyncRuntimeDrain(record.id);
        stopAutoSync(record.id);
        await stopWatcher(record.id);
        await removeSyncRuntime(record.id);
        throw error;
      }
    },
    unregistering: async (record) => {
      const runtime = getSyncRuntime(record.id);
      beginSyncRuntimeDrain(record.id);
      try {
        for (const device of await runtime.devices.list()) disconnectSyncWebSockets(device.deviceId, record.id);
        await waitForSyncRuntimeDrain(record.id);
        for (const device of await runtime.devices.list()) disconnectSyncWebSockets(device.deviceId, record.id);
        stopAutoSync(record.id);
        await stopWatcher(record.id);
        await removeSyncRuntime(record.id);
      } catch (error) {
        cancelSyncRuntimeDrain(record.id);
        if (!vaultWatchers.has(record.id)) await setupWatcher(runtime.context).catch(() => {});
        startAutoSync(runtime.context);
        throw error;
      }
    },
  });
  for (const runtime of syncRuntimes) {
    if (runtime.coordinator.health().readOnly) {
      console.error(`[sync] vault=${runtime.context.vaultId} read-only degraded mode: ${runtime.coordinator.health().reason}`);
    }
  }

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32mb' }));
  app.use(cookieParser());
  // Select a vault context for every request. Missing selector intentionally
  // resolves to the default vault so pre-v4 clients remain compatible.
  app.use(selectedVaultMiddleware);
  app.use((_req, res, next) => {
    let runtime: ReturnType<typeof getSyncRuntime>;
    try { runtime = getSyncRuntime(); }
    catch (error) { next(error); return; }
    const release = leaseSyncRuntime(runtime);
    if (!release) { next(Object.assign(new Error('Selected vault is draining'), { status: 503 })); return; }
    res.once('finish', release);
    res.once('close', release);
    next();
  });

  // Per-request CSP nonce — used by the SSR share page's inline <script>.
  app.use((_req, res, next) => {
    res.locals.cspNonce = randomBytes(16).toString('base64');
    next();
  });
  // Security headers. The CSP intentionally does NOT emit `upgrade-insecure-requests`
  // (it would break plain-HTTP self-hosting). `script-src` is 'self' + per-request
  // nonce; `style-src` allows inline styles (React inline styles + the SSR page's
  // <style>). Note: inline <script> inside ```html render-blocks won't execute under
  // this policy — acceptable for the marginal XSS hardening it buys.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", (_req, res) => `'nonce-${(res as Response).locals.cspNonce}'`],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          objectSrc: ["'none'"],
          frameSrc: ["'self'", 'blob:'],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
      // Allow social crawlers / other sites to load public share og:images.
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  if (!config.isProd) {
    app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
  }

  // Health (no auth) — for docker healthcheck
  app.get('/healthz', asyncHandler(async (_req, res) => {
    const vaults = listSyncRuntimes().map((runtime) => ({ vaultId: runtime.context.vaultId, ...runtime.coordinator.health() }));
    const unhealthy = vaults.some((runtime) => runtime.readOnly);
    const current = await getPersistedSettings();
    const sync = getSyncRuntime(current.vaults.defaultVaultId).coordinator.health();
    res.status(unhealthy ? 503 : 200).json({ ok: !unhealthy, sync, vaults });
  }));

  // Routes. NOTE: specific /api/* routers must be registered BEFORE the broad
  // '/api' search router, whose router-level requireAuth middleware would
  // otherwise gate every /api/* path (incl. /api/v1 and /api/keys) by prefix.
  app.use('/auth', authRouter);
  app.use('/api/v1', agentRouter); // agent API (api-key auth)
  app.use('/api/vaults', vaultsRouter);
  app.use('/api/sync/v1', syncRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/git', gitRouter);
  app.use('/api/keys', keysRouter);
  app.use('/api/plugins', pluginsRouter);
  app.use('/api/uistate', uiStateRouter);
  app.use('/api/shares', sharesRouter); // manage public share links (auth)
  app.use('/public/shares', publicSharesRouter); // shared-note content (NO auth)
  app.use('/share', sharePageRouter); // SSR public share page (NO auth, SEO/OG meta)
  app.use('/api', searchRouter); // /api/search, /api/tags, /api/backlinks, /api/graph...

  // Static SPA (built into server/public)
  const publicDir = path.join(__dirname, '..', 'public');
  if (await dirExists(publicDir)) {
    app.use(express.static(publicDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/public')) return next();
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  app.use(errorHandler);

  // Build independent projections/watchers for every registered vault.
  for (const runtime of syncRuntimes) await initializeVaultServices(runtime);
  console.log('[boot] all vault indexes ready');

  const server = http.createServer(app);
  setupWebsocket(server);

  server.listen(config.port, config.host, () => {
    console.log(`\n  WebObsidian server → http://${config.host}:${config.port}`);
    console.log(`  Vaults: ${persistedSettings.vaults.items.length}`);
    console.log(`  Data:   ${config.dataDir}\n`);
  });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${signal}: draining HTTP and checkpointing sync projection`);
    const runtimes = listSyncRuntimes();
    for (const runtime of runtimes) beginSyncRuntimeDrain(runtime.context.vaultId);
    server.close();
    // Refuse new leases, wait for accepted HTTP work, stop filesystem/Git
    // producers, then checkpoint. WebSocket wake connections cannot block exit.
    const checkpoint = Promise.all(runtimes.map((runtime) => waitForSyncRuntimeDrain(runtime.context.vaultId)))
      .then(async () => {
        await Promise.all(runtimes.map(async (runtime) => {
          stopAutoSync(runtime.context.vaultId);
          await stopWatcher(runtime.context.vaultId);
        }));
        await shutdownSyncRuntime();
      });
    void checkpoint.then(() => process.exit(0), (error) => {
      console.error('[shutdown] sync checkpoint failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    setTimeout(() => process.exit(1), 30_000).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

async function initializeVaultServices(runtime: ReturnType<typeof getSyncRuntime>): Promise<void> {
  await runInVault(runtime.context, async () => {
    console.log(`[boot] indexing vault ${runtime.context.vaultId}...`);
    await initSearch();
    await buildLinkGraph();
    await buildFileIndex();
    setupSyncSubscribers(runtime.coordinator, runtime.context);
    await setupWatcher(runtime.context);
    startAutoSync(runtime.context);
  });
}

function setupSyncSubscribers(coordinator: ReturnType<typeof getSyncCoordinator>, context: VaultContext) {
  coordinator.subscribe((event: SyncEvent) => runInVault(context, async () => {
    const removed = event.operation === 'delete' || event.operation === 'rmdir';
    const oldPath = event.oldPath;
    invalidateStat(event.path);
    if (oldPath) invalidateStat(oldPath);
    if (removed) {
      unindexFile(event.path);
      qmd.remove(event.path);
      if (/\.(md|markdown)$/i.test(event.path)) await updateLinkGraphForFile(event.path, true).catch(() => {});
    } else {
      indexFile(event.path);
      if (event.operation === 'rename' && oldPath) {
        unindexFile(oldPath);
        await qmd.rename(oldPath, event.path).catch(() => {});
        await onFileRenamed(oldPath, event.path).catch(() => {});
        if (/\.(md|markdown)$/i.test(oldPath)) await updateLinkGraphForFile(oldPath, true).catch(() => {});
      } else if (/\.(md|markdown)$/i.test(event.path)) {
        await qmd.upsert(event.path).catch(() => {});
      }
      if (/\.(md|markdown)$/i.test(event.path)) await updateLinkGraphForFile(event.path).catch(() => {});
    }
    scheduleAutoCommitOnSave();
    broadcast({ type: 'syncChanged', latestSequence: event.sequence });
    broadcast({ type: 'fs', event: event.operation, path: event.path });
  }));
}

// --- WebSocket: broadcast filesystem & UI-state events to connected clients ----
// Auth-gated: the WS stream leaks vault structure (paths of created/changed/deleted
// files), so the upgrade is rejected unless the request carries a valid session.
function setupWebsocket(server: http.Server) {
  const wss = new WebSocketServer({ noServer: true });
  const syncClients = new WeakSet<object>();
  const clientVaults = new WeakMap<object, string>();
  const syncClientsByDevice = new Map<string, Set<import('ws').WebSocket>>();
  const alive = new WeakMap<object, boolean>();
  registerSyncWebSocketDisconnect((deviceId, vaultId) => {
    for (const [key, clients] of syncClientsByDevice) {
      if (!key.endsWith(`:${deviceId}`) || (vaultId && !key.startsWith(`${vaultId}:`))) continue;
      for (const client of clients) client.terminate();
      syncClientsByDevice.delete(key);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      pathname = '';
    }
    if (pathname === '/api/sync/v1/ws') {
      const address = req.socket.remoteAddress ?? '';
      const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
      if (!loopback && req.headers['x-forwarded-proto'] !== 'https') {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const ticket = new URL(req.url ?? '', 'http://localhost').searchParams.get('ticket') ?? '';
      const consumed = wsTickets.consumeDetailed(ticket);
      if (!consumed) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      void (async () => {
        let runtime: ReturnType<typeof getSyncRuntime>;
        try { runtime = getSyncRuntime(consumed.vaultId); }
        catch {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
        }
        const release = leaseSyncRuntime(runtime);
        if (!release) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
        }
        socket.once('close', release);
        const active = (await runtime.devices.list()).some((device) => device.deviceId === consumed.deviceId && !device.revokedAt);
        if (!active) {
          release(); socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          syncClients.add(ws);
          release();
          clientVaults.set(ws, consumed.vaultId);
          const key = `${consumed.vaultId}:${consumed.deviceId}`;
          const clients = syncClientsByDevice.get(key) ?? new Set(); clients.add(ws); syncClientsByDevice.set(key, clients);
          ws.on('close', () => { clients.delete(ws); if (!clients.size) syncClientsByDevice.delete(key); });
          wss.emit('connection', ws, req);
        });
      })();
      return;
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const token = cookieValue(req.headers.cookie, COOKIE_NAME) ?? bearerToken(req.headers.authorization);
    const requestedVaultId = new URL(req.url ?? '', 'http://localhost').searchParams.get('vaultId') ?? undefined;
    void (async () => {
      if (!token || !(await verifyToken(token))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      let context: VaultContext;
      try { context = await vaultContext(requestedVaultId); }
      catch {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        clientVaults.set(ws, context.vaultId);
        wss.emit('connection', ws, req);
      });
    })();
  });

  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    if (!syncClients.has(ws)) ws.send(JSON.stringify({ type: 'hello' }));
  });
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (alive.get(client) === false) {
        client.terminate();
        continue;
      }
      alive.set(client, false);
      client.ping();
    }
  }, 30_000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
  setBroadcaster((msg, vaultId) => {
    if (!vaultId) return;
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState !== 1 || clientVaults.get(client) !== vaultId) continue;
      if (client.bufferedAmount > 1024 * 1024) {
        client.terminate();
        continue;
      }
      if (syncClients.has(client)) {
        if (msg && typeof msg === 'object' && 'type' in msg && msg.type === 'syncChanged'
          && 'latestSequence' in msg && typeof msg.latestSequence === 'number') {
          client.send(JSON.stringify({ type: 'sync.changed', vaultId, latestSequence: msg.latestSequence }));
        }
      } else client.send(data);
    }
  });
}

/** Parse a single cookie value out of a raw `Cookie:` header (no cookie-parser on upgrade). */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

// --- chokidar watcher: reflect external changes (git pull, direct edits) ---
const vaultWatchers = new Map<string, { close: () => Promise<void>; driftTimer: NodeJS.Timeout }>();

async function setupWatcher(context: VaultContext) {
  const root = context.root;
  // WEBOBSIDIAN_WATCH: 'auto' (default) = native inotify with automatic polling
  // fallback when the host watch limit is exceeded; 'polling' = force polling.
  const forcePolling = (process.env.WEBOBSIDIAN_WATCH ?? 'auto').toLowerCase() === 'polling';
  startWatcher(root, forcePolling, context);
}

function startWatcher(root: string, usePolling: boolean, context: VaultContext) {
  const watcher = chokidar.watch(root, {
    // Ignore VCS/dep/trash dirs AND `.obsidian` — the desktop Obsidian app
    // rewrites its workspace/state files constantly, which otherwise floods the
    // server with events (→ broadcasts → full tree refetches) and pins the CPU.
    ignored: (p) => /(^|[/\\])(\.git|\.obsidian|node_modules|\.trash)([/\\]|$)/.test(p),
    ignoreInitial: true,
    persistent: true,
    usePolling,
    interval: 1000,
    binaryInterval: 3000,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    alwaysStat: true,
  });

  // On a fresh VPS the kernel's `fs.inotify.max_user_watches` is often far below
  // the file count of a large vault, so native watching fails with ENOSPC/EMFILE.
  // Self-heal by transparently switching to polling (no inotify), and tell the
  // operator how to restore native (cheaper) watching.
  let degraded = false;
  watcher.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (!usePolling && !degraded && (code === 'ENOSPC' || code === 'EMFILE')) {
      degraded = true;
      console.warn(
        `[watcher] native file watching hit ${code} (host inotify limit too low ` +
        `for this vault). Falling back to polling. For lower CPU, raise the limit: ` +
        `sudo sysctl -w fs.inotify.max_user_watches=524288`,
      );
      const prior = vaultWatchers.get(context.vaultId);
      if (prior) clearInterval(prior.driftTimer);
      vaultWatchers.delete(context.vaultId);
      watcher.close().catch(() => {});
      startWatcher(root, true, context);
      return;
    }
    console.error('[watcher] error:', err);
  });

  const pendingUnlinks = new Map<string, { hash: string | null; inode?: number; kind: 'file' | 'directory'; timer: NodeJS.Timeout }>();
  const knownInodes = new Map<string, number>();
  const reconcile = async (rel: string, type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir') => {
    try { await getSyncCoordinator().reconcileExternalPath(rel, type); }
    catch (error) { console.error(`[watcher] failed to reconcile ${type} ${rel}:`, error); }
  };
  const onChange = async (absPath: string, type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir', stats?: Stats) => {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    if (stats?.ino && type !== 'unlink' && type !== 'unlinkDir') knownInodes.set(rel, stats.ino);
    if (type === 'unlink' || type === 'unlinkDir') {
      const current = await getSyncCoordinator().entryByPath(rel);
      const timer = setTimeout(() => {
        pendingUnlinks.delete(rel);
        void reconcile(rel, type);
      }, 750);
      pendingUnlinks.set(rel, {
        hash: current?.hash ?? null,
        ...(knownInodes.get(rel) ? { inode: knownInodes.get(rel) } : {}),
        kind: type === 'unlinkDir' ? 'directory' : 'file',
        timer,
      });
      knownInodes.delete(rel);
      return;
    }
    if (type === 'add') {
      const hash = await sha256Chunks(createReadStream(absPath)).catch(() => null);
      const candidates = [...pendingUnlinks.entries()].filter(([, pending]) =>
        pending.kind === 'file' && ((pending.inode && stats?.ino && pending.inode === stats.ino) || pending.hash === hash));
      if (hash && candidates.length === 1) {
        const [from, pending] = candidates[0]!;
        clearTimeout(pending.timer);
        pendingUnlinks.delete(from);
        try {
          await getSyncCoordinator().reconcileExternalRename(from, rel);
          return;
        } catch (error) {
          console.warn(`[watcher] rename correlation ${from} → ${rel} rejected; using delete+create`, error);
          await reconcile(from, 'unlink');
        }
      }
    }
    await reconcile(rel, type);
  };
  watcher
    .on('add', (p, stats) => runInVault(context, () => onChange(p, 'add', stats)))
    .on('change', (p, stats) => runInVault(context, () => onChange(p, 'change', stats)))
    .on('unlink', (p) => runInVault(context, () => onChange(p, 'unlink')))
    .on('addDir', (p, stats) => runInVault(context, () => onChange(p, 'addDir', stats)))
    .on('unlinkDir', (p) => runInVault(context, () => onChange(p, 'unlinkDir')));

  let driftScanRunning = false;
  const driftInterval = Math.max(10_000, Number(process.env.SYNC_DRIFT_SCAN_MS ?? 60_000));
  const driftTimer = setInterval(() => {
    if (driftScanRunning) return;
    driftScanRunning = true;
    void runInVault(context, () => getSyncCoordinator().reconcileExternalDrift())
      .catch((error) => console.error(`[watcher] vault=${context.vaultId} periodic drift scan failed:`, error))
      .finally(() => { driftScanRunning = false; });
  }, driftInterval);
  driftTimer.unref();
  vaultWatchers.set(context.vaultId, { close: () => watcher.close(), driftTimer });
}

async function stopWatcher(vaultId: string): Promise<void> {
  const state = vaultWatchers.get(vaultId);
  if (!state) return;
  clearInterval(state.driftTimer);
  vaultWatchers.delete(vaultId);
  await state.close();
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

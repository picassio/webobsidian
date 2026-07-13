import { promises as fs } from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { evaluatePathPolicy } from '@picassio/sync-core';
import { FilesystemAdapter } from './fs-adapter.js';
import { FilesystemMutationQueue } from './local-queue.js';
import { HeadlessStore } from './state.js';

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private deleted = new Map<string, { path: string; hash: string | null; timer: NodeJS.Timeout }>();
  constructor(
    private readonly store: HeadlessStore,
    private readonly adapter: FilesystemAdapter,
    private readonly queue: FilesystemMutationQueue,
  ) {}
  async start(polling = false): Promise<void> {
    this.watcher = chokidar.watch(this.store.state.vaultPath, {
      persistent: true, ignoreInitial: true, followSymlinks: false,
      usePolling: polling, interval: polling ? 1_000 : undefined,
      awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 100 },
      ignored: (candidate) => this.ignored(candidate),
    });
    this.watcher.on('add', (file) => void this.added(file, false));
    this.watcher.on('addDir', (file) => void this.added(file, true));
    this.watcher.on('change', (file) => void this.changed(file));
    this.watcher.on('unlink', (file) => void this.removed(file, false));
    this.watcher.on('unlinkDir', (file) => void this.removed(file, true));
    await new Promise<void>((resolve, reject) => {
      this.watcher!.once('ready', resolve); this.watcher!.once('error', reject);
    });
  }
  async close(): Promise<void> {
    for (const item of this.deleted.values()) clearTimeout(item.timer);
    this.deleted.clear(); await this.watcher?.close(); this.watcher = null;
  }
  private async added(absolute: string, directory: boolean): Promise<void> {
    if (this.store.state.mode === 'pull-only') { await this.adapter.reconcilePullOnly(); return; }
    const relative = this.relative(absolute); if (!relative) return;
    const hash = directory ? null : (await this.adapter.hash(relative)).hash;
    const matches = [...this.deleted.entries()].filter(([, item]) => item.hash === hash);
    if (matches.length === 1) {
      const [key, prior] = matches[0]!; clearTimeout(prior.timer); this.deleted.delete(key);
      await this.queue.observe({ path: relative, action: 'rename', oldPath: prior.path, observedAt: new Date().toISOString() });
    } else await this.queue.observe({ path: relative, action: 'upsert', observedAt: new Date().toISOString() });
    await this.queue.flushAll();
  }
  private async changed(absolute: string): Promise<void> {
    if (this.store.state.mode === 'pull-only') { await this.adapter.reconcilePullOnly(); return; }
    const relative = this.relative(absolute); if (!relative) return;
    await this.queue.observe({ path: relative, action: 'upsert', observedAt: new Date().toISOString() });
    await this.queue.flushAll();
  }
  private async removed(absolute: string, directory: boolean): Promise<void> {
    if (this.store.state.mode === 'pull-only') { await this.adapter.reconcilePullOnly(); return; }
    const relative = this.relative(absolute); if (!relative) return;
    const projected = this.store.entryByPath(relative); const hash = directory ? null : (projected?.hash ?? null);
    const timer = setTimeout(() => {
      this.deleted.delete(relative);
      void this.queue.observe({ path: relative, action: 'delete', observedAt: new Date().toISOString() }).then(() => this.queue.flushAll());
    }, 750);
    this.deleted.set(relative, { path: relative, hash, timer });
  }
  private relative(absolute: string): string | null {
    const value = path.relative(this.store.state.vaultPath, absolute).split(path.sep).join('/').normalize('NFC');
    return value && !value.startsWith('..') ? value : null;
  }
  private ignored(candidate: string): boolean {
    const relative = path.relative(this.store.state.vaultPath, candidate).split(path.sep).join('/');
    if (!relative) return false;
    if (relative === '.web-vault-sync-quarantine' || relative.startsWith('.web-vault-sync-quarantine/')) return true;
    if (!evaluatePathPolicy(relative).allowed) return true;
    return this.store.state.excludeGlobs.some((glob) => globRegex(glob).test(relative));
  }
}

export async function acquireInstanceLock(store: HeadlessStore): Promise<() => Promise<void>> {
  await fs.mkdir(store.configDir, { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(store.lockFile, 'wx', 0o600);
    await handle.writeFile(`${process.pid}\n`); await handle.sync(); await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number((await fs.readFile(store.lockFile, 'utf8')).trim());
    try { process.kill(pid, 0); throw new Error(`another daemon is running with PID ${pid}`); }
    catch (probe) {
      if (probe instanceof Error && probe.message.startsWith('another daemon')) throw probe;
      await fs.rm(store.lockFile, { force: true }); return acquireInstanceLock(store);
    }
  }
  return async () => { await fs.rm(store.lockFile, { force: true }); };
}
function globRegex(glob: string): RegExp {
  let result = ''; for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*' && glob[index + 1] === '*') { result += '.*'; index += 1; }
    else if (char === '*') result += '[^/]*'; else if (char === '?') result += '[^/]';
    else result += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  } return new RegExp(`^${result}$`, 'u');
}

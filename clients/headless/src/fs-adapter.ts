import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import {
  assertNoCaseFoldCollision,
  assertServerPathAllowed,
  evaluatePathPolicy,
  sha256Chunks,
  type ClientApplyIntent,
  type OperationResult,
  type SyncEntry,
  type SyncEvent,
  type SyncLocalAdapter,
  type SyncOperation,
} from '@picassio/sync-core';
import { HeadlessStore } from './state.js';
import { NodeSyncTransport } from './transport.js';

export class FilesystemAdapter implements SyncLocalAdapter {
  private expected = new Map<string, { hash: string | null; revision: number }>();
  private root = '';
  constructor(
    private readonly store: HeadlessStore,
    private readonly transport: NodeSyncTransport,
    private readonly onConflict: (result: OperationResult | string) => void,
  ) {}
  async initialize(): Promise<void> { this.root = await fs.realpath(this.store.state.vaultPath); }

  async bootstrap(entries: SyncEntry[]): Promise<void> {
    const protectedPaths = new Set(this.store.state.operations.flatMap((operation) => {
      if ('path' in operation && (operation.operation === 'create' || operation.operation === 'mkdir')) return [operation.path];
      if ('entryId' in operation) { const prior = this.store.entryById(operation.entryId); return prior ? [prior.path] : []; }
      return [];
    }));
    if (this.store.state.mode !== 'push-only') {
      for (const entry of entries.filter((item) => !item.deleted).sort((a, b) => depth(a.path) - depth(b.path))) {
        if (!protectedPaths.has(entry.path)) await this.applyEntry(entry);
      }
    }
    await this.store.replaceEntries(entries);
  }
  async apply(event: SyncEvent): Promise<void> {
    const prior = this.store.entryById(event.entryId);
    if (this.store.state.mode !== 'push-only') {
      if (event.operation === 'delete' || event.operation === 'rmdir') await this.remove(event.path, prior, event.revision);
      else if (event.operation === 'rename') await this.rename(event.oldPath!, event.path, event.hash, event.revision);
      else await this.applyEntry({
        entryId: event.entryId, path: event.path, kind: event.operation === 'mkdir' ? 'directory' : 'file',
        revision: event.revision, hash: event.hash, size: event.size, modifiedAt: event.occurredAt,
        deleted: false, sequence: event.sequence,
      });
    }
    await this.store.putEntry({
      entryId: event.entryId, path: event.path,
      kind: event.operation === 'mkdir' || event.operation === 'rmdir' ? 'directory' : (prior?.kind ?? 'file'),
      revision: event.revision, hash: event.hash, size: event.size, modifiedAt: event.occurredAt,
      deleted: event.operation === 'delete' || event.operation === 'rmdir', sequence: event.sequence,
    });
  }
  async recover(intent: ClientApplyIntent): Promise<void> { await this.apply(intent.event); }
  async committed(operation: SyncOperation, result: OperationResult): Promise<void> {
    if (result.status === 'merged' && 'content' in operation && operation.content && result.path) {
      await this.store.putMergedSource(result.path, operation.content.hash);
    }
  }
  async conflict(result: OperationResult): Promise<void> { this.onConflict(result); }

  async consumeExpected(filePath: string, hash: string | null): Promise<boolean> {
    const expected = this.expected.get(filePath);
    if (!expected || expected.hash !== hash) return false;
    this.expected.delete(filePath); return true;
  }
  async hash(relative: string): Promise<{ hash: string; size: number }> {
    const absolute = await this.safeAbsolute(relative, false);
    const before = await fs.stat(absolute);
    if (!before.isFile()) throw new Error(`not a regular file: ${relative}`);
    const hash = await sha256Chunks((await import('node:fs')).createReadStream(absolute));
    const after = await fs.stat(absolute);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`file changed while hashing: ${relative}`);
    return { hash, size: after.size };
  }
  async reconcilePullOnly(): Promise<void> {
    if (this.store.state.mode !== 'pull-only') return;
    const local = await this.scan();
    const live = this.store.state.entries.filter((entry) => !entry.deleted);
    for (const item of local.filter((entry) => entry.kind === 'file')) {
      const projected = live.find((entry) => entry.path === item.path);
      if (!projected || projected.kind !== item.kind || projected.hash !== item.hash) await this.quarantine(item.path);
    }
    for (const entry of live.sort((a, b) => depth(a.path) - depth(b.path))) {
      const localEntry = local.find((item) => item.path === entry.path);
      if (!localEntry || localEntry.hash !== entry.hash || localEntry.kind !== entry.kind) await this.applyEntry(entry);
    }
  }

  async scan(): Promise<Array<{ path: string; kind: 'file' | 'directory'; hash: string | null; size: number }>> {
    const results: Array<{ path: string; kind: 'file' | 'directory'; hash: string | null; size: number }> = [];
    const walk = async (directory: string, prefix = ''): Promise<void> => {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        if (relative === '.web-vault-sync-quarantine' || excluded(relative, this.store.state.excludeGlobs)) continue;
        if (item.isSymbolicLink()) throw new Error(`symlink is not allowed: ${relative}`);
        if (item.isDirectory()) { results.push({ path: relative.normalize('NFC'), kind: 'directory', hash: null, size: 0 }); await walk(path.join(directory, item.name), relative); }
        else if (item.isFile()) { const hashed = await this.hash(relative.normalize('NFC')); results.push({ path: relative.normalize('NFC'), kind: 'file', ...hashed }); }
      }
    };
    await walk(this.root); assertNoCaseFoldCollision(results.map((item) => item.path)); return results;
  }

  private async applyEntry(entry: SyncEntry): Promise<void> {
    assertServerPathAllowed(entry.path);
    const absolute = await this.safeAbsolute(entry.path, true);
    if (entry.kind === 'directory') { await fs.mkdir(absolute, { recursive: true }); this.expected.set(entry.path, { hash: null, revision: entry.revision }); return; }
    if (!entry.hash) throw new Error(`file has no hash: ${entry.path}`);
    const current = await this.currentHash(entry.path);
    const submittedMergeSource = this.store.mergedSource(entry.path);
    if (current === entry.hash) {
      this.expected.set(entry.path, { hash: entry.hash, revision: entry.revision });
      if (submittedMergeSource) await this.store.removeMergedSource(entry.path);
      return;
    }
    const prior = this.store.entryByPath(entry.path);
    if (current && prior?.hash && current !== prior.hash && current !== submittedMergeSource) await this.quarantine(entry.path);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.sync-${process.pid}-${Date.now()}`;
    const response = await this.transport.download(entry.entryId, entry.revision);
    if (!response.body) throw new Error('download body is unavailable');
    const hash = createHash('sha256'); let size = 0;
    const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); size += chunk.length; callback(null, chunk); } });
    const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    try {
      await pipeline(Readable.fromWeb(response.body as never), verify, output);
      const actual = hash.digest('hex');
      if (actual !== entry.hash || size !== entry.size) throw new Error(`download verification failed: ${entry.path}`);
      const handle = await fs.open(temporary, 'r'); try { await handle.sync(); } finally { await handle.close(); }
      this.expected.set(entry.path, { hash: entry.hash, revision: entry.revision });
      await fs.rename(temporary, absolute); await syncDirectory(path.dirname(absolute));
      if (submittedMergeSource) await this.store.removeMergedSource(entry.path);
    } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  }
  private async rename(from: string, to: string, hash: string | null, revision: number): Promise<void> {
    const source = await this.safeAbsolute(from, true); const destination = await this.safeAbsolute(to, true);
    if (!(await exists(source))) return;
    if (await exists(destination)) throw new Error(`rename destination exists: ${to}`);
    await fs.mkdir(path.dirname(destination), { recursive: true }); this.expected.set(to, { hash, revision });
    if (source.toLocaleLowerCase('en-US') === destination.toLocaleLowerCase('en-US') && source !== destination) {
      const temporary = `${source}.case-${process.pid}`; await fs.rename(source, temporary); await fs.rename(temporary, destination);
    } else await fs.rename(source, destination);
  }
  private async remove(filePath: string, prior: SyncEntry | null, revision: number): Promise<void> {
    const absolute = await this.safeAbsolute(filePath, true); if (!(await exists(absolute))) return;
    if (prior?.kind === 'file') {
      const current = await this.currentHash(filePath);
      if (current && prior.hash && current !== prior.hash) { await this.quarantine(filePath); return; }
    }
    this.expected.set(filePath, { hash: null, revision }); await fs.rm(absolute, { recursive: true, force: true });
  }
  private async quarantine(filePath: string): Promise<void> {
    const source = await this.safeAbsolute(filePath, false); const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(this.root, '.web-vault-sync-quarantine', stamp, ...filePath.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.rename(source, destination);
    this.onConflict(`local drift quarantined: ${filePath}`);
  }
  private async currentHash(filePath: string): Promise<string | null> {
    try { return (await this.hash(filePath)).hash; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async safeAbsolute(relative: string, allowMissing: boolean): Promise<string> {
    assertServerPathAllowed(relative); const absolute = path.resolve(this.root, ...relative.split('/'));
    if (!absolute.startsWith(`${this.root}${path.sep}`)) throw new Error('path escapes vault');
    let probe = absolute;
    while (probe !== this.root) {
      try { if ((await fs.lstat(probe)).isSymbolicLink()) throw new Error(`symlink path is not allowed: ${relative}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      probe = path.dirname(probe);
    }
    if (!allowMissing) await fs.access(absolute); return absolute;
  }
}

function excluded(filePath: string, globs: string[]): boolean {
  const policy = evaluatePathPolicy(filePath); if (!policy.allowed) return true;
  return globs.some((glob) => globToRegex(glob).test(filePath));
}
function globToRegex(glob: string): RegExp {
  let result = ''; for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*' && glob[index + 1] === '*') { result += '.*'; index += 1; }
    else if (char === '*') result += '[^/]*'; else if (char === '?') result += '[^/]';
    else result += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  } return new RegExp(`^${result}$`, 'u');
}
async function exists(file: string) { try { await fs.access(file); return true; } catch { return false; } }
async function syncDirectory(directory: string) { const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
function depth(filePath: string) { return filePath.split('/').length; }

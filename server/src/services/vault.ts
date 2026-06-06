import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getSettings } from './settings.js';

export interface TreeNode {
  name: string;
  path: string; // vault-relative, posix style
  type: 'file' | 'folder';
  ext?: string;
  size?: number;
  mtime?: number;
  children?: TreeNode[];
}

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.canvas', '.css', '.js', '.yml', '.yaml',
]);

const IGNORED = new Set(['.git', 'node_modules']);

export async function getVaultRoot(): Promise<string> {
  const s = await getSettings();
  return path.resolve(s.vault.path);
}

/** Resolve a vault-relative path to an absolute one, refusing traversal. */
export async function resolveInVault(relPath: string): Promise<string> {
  const root = await getVaultRoot();
  const clean = relPath.replace(/^[/\\]+/, '');
  const abs = path.resolve(root, clean);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw Object.assign(new Error('Path escapes vault'), { status: 400 });
  }
  return abs;
}

export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

export async function ensureVault(): Promise<void> {
  const root = await getVaultRoot();
  await fs.mkdir(root, { recursive: true });
}

/** Build the full tree (folders + files), skipping ignored dirs. */
export async function listTree(): Promise<TreeNode> {
  const root = await getVaultRoot();
  await fs.mkdir(root, { recursive: true });

  async function walk(absDir: string): Promise<TreeNode[]> {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    const nodes: TreeNode[] = [];
    for (const e of entries) {
      if (IGNORED.has(e.name) || e.name.startsWith('.')) continue; // hide dotfiles like Obsidian
      const abs = path.join(absDir, e.name);
      const rel = toRel(root, abs);
      if (e.isDirectory()) {
        nodes.push({
          name: e.name,
          path: rel,
          type: 'folder',
          children: await walk(abs),
        });
      } else if (e.isFile()) {
        // No per-file fs.stat() here: with ~27k files it meant 27k syscalls on
        // every tree fetch (and the tree is refetched on each fs event). The UI
        // doesn't use size/mtime, so the dirent alone is enough.
        nodes.push({
          name: e.name,
          path: rel,
          type: 'file',
          ext: path.extname(e.name).toLowerCase(),
        });
      }
    }
    // folders first, then alphabetical
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }

  return { name: path.basename(root), path: '', type: 'folder', children: await walk(root) };
}

export function isTextFile(rel: string): boolean {
  return TEXT_EXTS.has(path.extname(rel).toLowerCase());
}

export async function readFileText(rel: string): Promise<string> {
  const abs = await resolveInVault(rel);
  return fs.readFile(abs, 'utf8');
}

export async function readFileBuffer(rel: string): Promise<Buffer> {
  const abs = await resolveInVault(rel);
  return fs.readFile(abs);
}

export async function writeFileText(rel: string, content: string): Promise<void> {
  const abs = await resolveInVault(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, abs);
}

export async function writeFileBuffer(rel: string, buf: Buffer): Promise<void> {
  const abs = await resolveInVault(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
}

export async function createFolder(rel: string): Promise<void> {
  const abs = await resolveInVault(rel);
  await fs.mkdir(abs, { recursive: true });
}

export async function exists(rel: string): Promise<boolean> {
  try {
    await fs.access(await resolveInVault(rel));
    return true;
  } catch {
    return false;
  }
}

export async function rename(from: string, to: string): Promise<void> {
  const absFrom = await resolveInVault(from);
  const absTo = await resolveInVault(to);
  await fs.mkdir(path.dirname(absTo), { recursive: true });
  await fs.rename(absFrom, absTo);
}

/** Move a path into the vault trash folder, preserving relative layout. */
export async function trash(rel: string): Promise<string> {
  const s = await getSettings();
  const root = await getVaultRoot();
  const absFrom = await resolveInVault(rel);
  const trashRoot = path.join(root, s.vault.trash);
  const dest = path.join(trashRoot, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  // avoid collision
  let finalDest = dest;
  if (await pathExists(finalDest)) {
    const ext = path.extname(dest);
    finalDest = `${dest.slice(0, dest.length - ext.length)}.${Date.now()}${ext}`;
  }
  await fs.rename(absFrom, finalDest);
  return toRel(root, finalDest);
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/** List all markdown files (vault-relative) for indexing. */
export async function listMarkdownFiles(): Promise<string[]> {
  const root = await getVaultRoot();
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) out.push(toRel(root, abs));
    }
  }
  await walk(root);
  return out;
}

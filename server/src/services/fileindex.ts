import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getVaultRoot, toRel } from './vault.js';
import { currentVaultId } from './vault-context.js';

/**
 * Vault-wide file index for Obsidian-style attachment resolution: an embed like
 * `![[image.jpg]]` or `![](image.jpg)` can reference a file living anywhere in
 * the vault (commonly an Attachments folder). We index every file by basename
 * and resolve by shortest path when a link doesn't include an explicit folder.
 */

const IGNORED = new Set(['.git', 'node_modules']);

interface FileIndexes { byBasename: Map<string, string>; byBasenameNoExt: Map<string, string> }
const indexes = new Map<string, FileIndexes>();
function currentIndexes(): FileIndexes {
  const key = currentVaultId() ?? '__default__';
  let value = indexes.get(key);
  if (!value) { value = { byBasename: new Map(), byBasenameNoExt: new Map() }; indexes.set(key, value); }
  return value;
}

function depth(p: string): number {
  return p.split('/').length;
}

function record(maps: { b: Map<string, string>; bn: Map<string, string> }, rel: string): void {
  const name = (rel.split('/').pop() ?? rel).toLowerCase();
  const prev = maps.b.get(name);
  if (!prev || depth(rel) < depth(prev)) maps.b.set(name, rel); // prefer shortest path
  const noExt = name.replace(/\.[^.]+$/, '');
  const prevN = maps.bn.get(noExt);
  if (!prevN || depth(rel) < depth(prevN)) maps.bn.set(noExt, rel);
}

export async function buildFileIndex(): Promise<void> {
  const root = await getVaultRoot();
  const maps = { b: new Map<string, string>(), bn: new Map<string, string>() };
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORED.has(e.name) || e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) record(maps, toRel(root, abs));
    }
  }
  await walk(root);
  indexes.set(currentVaultId() ?? '__default__', { byBasename: maps.b, byBasenameNoExt: maps.bn });
}

/** Resolve a link target (basename or partial path) to a real vault path. */
export function resolveFile(name: string): string | undefined {
  const base = (name.split('/').pop() ?? name).toLowerCase();
  const { byBasename, byBasenameNoExt } = currentIndexes();
  return byBasename.get(base) ?? byBasenameNoExt.get(base.replace(/\.[^.]+$/, ''));
}

export function indexFile(rel: string): void {
  const { byBasename, byBasenameNoExt } = currentIndexes();
  record({ b: byBasename, bn: byBasenameNoExt }, rel);
}

export function unindexFile(rel: string): void {
  const { byBasename, byBasenameNoExt } = currentIndexes();
  const name = (rel.split('/').pop() ?? rel).toLowerCase();
  if (byBasename.get(name) === rel) byBasename.delete(name);
  const noExt = name.replace(/\.[^.]+$/, '');
  if (byBasenameNoExt.get(noExt) === rel) byBasenameNoExt.delete(noExt);
}

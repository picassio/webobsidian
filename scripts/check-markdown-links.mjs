import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'public']);
const markdownFiles = await collect(root);
const failures = [];

for (const file of markdownFiles) {
  const source = await fs.readFile(file, 'utf8');
  const searchable = source
    .replace(/^\s*(```|~~~).*?^\s*\1\s*$/gms, (block) => '\n'.repeat(block.split('\n').length - 1))
    .replace(/`[^`\n]*`/gu, '');
  const links = searchable.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/gu);
  for (const match of links) {
    const destination = normalizeDestination(match[1]);
    if (!destination || /^(?:https?:|mailto:|data:)/u.test(destination)) continue;
    const [rawTarget, rawFragment] = destination.split('#', 2);
    const target = decodeURIComponent(rawTarget || '');
    const resolved = path.resolve(path.dirname(file), target || path.basename(file));
    const line = searchable.slice(0, match.index).split('\n').length;
    if (!isInsideRoot(resolved)) {
      failures.push(`${relative(file)}:${line}: link escapes repository: ${destination}`);
      continue;
    }
    if (!(await exists(resolved))) {
      failures.push(`${relative(file)}:${line}: missing target: ${destination}`);
      continue;
    }
    if (rawFragment && path.extname(resolved).toLowerCase() === '.md') {
      const anchors = headingAnchors(await fs.readFile(resolved, 'utf8'));
      const fragment = decodeURIComponent(rawFragment).toLowerCase();
      if (!anchors.has(fragment)) failures.push(`${relative(file)}:${line}: missing anchor: ${destination}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Markdown links: ${markdownFiles.length} files, all relative targets and anchors valid`);
}

async function collect(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await collect(candidate));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(candidate);
  }
  return found;
}

function normalizeDestination(raw) {
  let value = raw.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
  return value.replace(/\s+["'][^"']*["']\s*$/u, '');
}

function headingAnchors(markdown) {
  const anchors = new Set();
  const occurrences = new Map();
  const withoutFences = markdown.replace(/^\s*(```|~~~).*?^\s*\1\s*$/gms, '');
  for (const match of withoutFences.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const base = match[1].toLowerCase().trim()
      .replace(/<[^>]+>/gu, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/gu, '-');
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function isInsideRoot(candidate) {
  const relativePath = path.relative(root, candidate);
  return relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

async function exists(candidate) {
  try { await fs.access(candidate); return true; } catch { return false; }
}

function relative(file) { return path.relative(root, file); }

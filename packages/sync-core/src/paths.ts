const RESERVED_SEGMENTS = new Set(['.git', '.trash', '.obsidian', 'node_modules']);
const OS_METADATA = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const TEMP_PATTERNS = [/(^|\/)\.?#.*#$/, /(^|\/).*\.sw[opx]$/i, /(^|\/).*~$/, /\.tmp-[^/]+$/i];

export type PathPolicyResult =
  | { allowed: true; path: string; folded: string }
  | { allowed: false; code: 'invalid_path' | 'excluded_path'; reason: string };

export function normalizeVaultPath(input: string): string {
  if (input !== input.normalize('NFC')) throw new Error('path must be NFC-normalized');
  if (!input || input.startsWith('/') || input.includes('\\') || input.includes('\0')) {
    throw new Error('path must be vault-relative POSIX');
  }
  const segments = input.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('path contains an invalid segment');
  }
  return segments.join('/');
}

export function foldVaultPath(path: string): string {
  return normalizeVaultPath(path).toLocaleLowerCase('en-US');
}

/** Server-enforced exclusions. A client may exclude more, never less. */
export function evaluatePathPolicy(input: string): PathPolicyResult {
  let path: string;
  try {
    path = normalizeVaultPath(input);
  } catch (error) {
    return { allowed: false, code: 'invalid_path', reason: error instanceof Error ? error.message : 'invalid path' };
  }
  const segments = path.split('/');
  const foldedSegments = segments.map((segment) => segment.toLocaleLowerCase('en-US'));
  const reserved = foldedSegments.find((segment) => RESERVED_SEGMENTS.has(segment));
  if (reserved) return { allowed: false, code: 'excluded_path', reason: `reserved segment: ${reserved}` };
  const basename = foldedSegments.at(-1)!;
  if (OS_METADATA.has(basename)) return { allowed: false, code: 'excluded_path', reason: 'OS metadata' };
  if (TEMP_PATTERNS.some((pattern) => pattern.test(path))) {
    return { allowed: false, code: 'excluded_path', reason: 'temporary/editor file' };
  }
  return { allowed: true, path, folded: foldedSegments.join('/') };
}

export function assertServerPathAllowed(input: string): string {
  const result = evaluatePathPolicy(input);
  if (!result.allowed) throw new Error(`${result.code}: ${result.reason}`);
  return result.path;
}

export function isServerPathExcluded(input: string): boolean {
  const result = evaluatePathPolicy(input);
  return !result.allowed && result.code === 'excluded_path';
}

export function assertNoCaseFoldCollision(paths: Iterable<string>): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const folded = foldVaultPath(path);
    const existing = seen.get(folded);
    if (existing && existing !== path) throw new Error(`case-fold path collision: ${existing} vs ${path}`);
    seen.set(folded, path);
  }
}

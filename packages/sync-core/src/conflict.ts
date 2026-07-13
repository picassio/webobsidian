import { diff3Merge } from 'node-diff3';

export const MAX_AUTO_MERGE_BYTES = 10 * 1024 * 1024;

export type TextMergeResult =
  | { clean: true; content: string }
  | { clean: false; reason: 'too_large' | 'binary' | 'overlap' | 'base_unavailable' };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function lineEnding(value: string): '\r\n' | '\n' {
  return value.includes('\r\n') ? '\r\n' : '\n';
}

function splitLines(value: string): { lines: string[]; trailing: boolean } {
  const normalized = value.replace(/\r\n/g, '\n');
  const trailing = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (trailing) lines.pop();
  return { lines, trailing };
}

/** Deterministic line-oriented diff3: current=A, exact base=O, submitted=B. */
export function mergeText(current: string, base: string | null, submitted: string): TextMergeResult {
  if (base === null) return { clean: false, reason: 'base_unavailable' };
  if ([current, base, submitted].some((value) => value.includes('\0'))) return { clean: false, reason: 'binary' };
  if ([current, base, submitted].some((value) => byteLength(value) > MAX_AUTO_MERGE_BYTES)) {
    return { clean: false, reason: 'too_large' };
  }
  const a = splitLines(current);
  const o = splitLines(base);
  const b = splitLines(submitted);
  const regions = diff3Merge(a.lines, o.lines, b.lines, { excludeFalseConflicts: true });
  if (regions.some((region) => region.conflict)) return { clean: false, reason: 'overlap' };
  const lines = regions.flatMap((region) => region.ok ?? []);
  const trailing = a.trailing || (current === base && b.trailing);
  return { clean: true, content: lines.join(lineEnding(current)) + (trailing ? lineEnding(current) : '') };
}

export function conflictCopyPath(path: string, deviceName: string, timestamp: Date, ordinal = 0): string {
  const slash = path.lastIndexOf('/');
  const directory = slash >= 0 ? path.slice(0, slash + 1) : '';
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  const safeDevice = deviceName.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 48) || 'device';
  const utc = timestamp.toISOString().replace(/[:.]/g, '-');
  const suffix = ordinal > 0 ? ` ${ordinal}` : '';
  return `${directory}${stem} (conflict from ${safeDevice} ${utc}${suffix})${extension}`;
}

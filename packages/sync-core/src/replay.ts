import type { SyncEntry, SyncEvent } from './schemas.js';
import { foldVaultPath } from './paths.js';

export class SequenceGapError extends Error {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(`event sequence gap: expected ${expected}, got ${actual}`);
    this.name = 'SequenceGapError';
  }
}

export interface ReplayState {
  sequence: number;
  entries: Map<string, SyncEntry>;
}

export function createReplayState(entries: Iterable<SyncEntry> = [], sequence = 0): ReplayState {
  return { sequence, entries: new Map([...entries].map((entry) => [entry.entryId, entry])) };
}

/** Pure deterministic projection used by server recovery and every client conformance suite. */
export function applyEvent(state: ReplayState, event: SyncEvent): ReplayState {
  const expected = state.sequence + 1;
  if (event.sequence !== expected) throw new SequenceGapError(expected, event.sequence);

  const entries = new Map(state.entries);
  const previous = entries.get(event.entryId);
  if (event.operation === 'create' || event.operation === 'mkdir') {
    if (previous && !previous.deleted) throw new Error(`entry ${event.entryId} already exists`);
    entries.set(event.entryId, {
      entryId: event.entryId,
      path: event.path,
      kind: event.operation === 'mkdir' ? 'directory' : 'file',
      revision: event.revision,
      hash: event.hash,
      size: event.size,
      modifiedAt: event.occurredAt,
      deleted: false,
      sequence: event.sequence,
    });
  } else {
    if (!previous) throw new Error(`event references unknown entry ${event.entryId}`);
    if (event.revision <= previous.revision) {
      throw new Error(`revision must increase for ${event.entryId}`);
    }
    const deleted = event.operation === 'delete' || event.operation === 'rmdir';
    entries.set(event.entryId, {
      ...previous,
      path: event.path,
      revision: event.revision,
      hash: deleted ? null : event.hash,
      size: deleted ? 0 : event.size,
      modifiedAt: event.occurredAt,
      deleted,
      sequence: event.sequence,
    });

    if (event.operation === 'rename' && previous.kind === 'directory') {
      const oldPrefix = `${event.oldPath}/`;
      const newPrefix = `${event.path}/`;
      for (const [entryId, child] of entries) {
        if (entryId === event.entryId || child.deleted || !child.path.startsWith(oldPrefix)) continue;
        entries.set(entryId, { ...child, path: newPrefix + child.path.slice(oldPrefix.length) });
      }
    }
  }

  assertNoLivePathCollisions(entries.values());
  return { sequence: event.sequence, entries };
}

export function replayEvents(initial: ReplayState, events: readonly SyncEvent[]): ReplayState {
  return events.reduce(applyEvent, initial);
}

export function assertNoLivePathCollisions(entries: Iterable<SyncEntry>): void {
  const paths = new Map<string, string>();
  for (const entry of entries) {
    if (entry.deleted) continue;
    const folded = foldVaultPath(entry.path);
    const existing = paths.get(folded);
    if (existing && existing !== entry.entryId) {
      throw new Error(`live path collision: ${entry.path}`);
    }
    paths.set(folded, entry.entryId);
  }
}

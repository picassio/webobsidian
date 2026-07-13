import { normalizeVaultPath } from '@picassio/sync-core';

interface Waiter {
  paths: string[];
  resolve: (release: () => void) => void;
}

/** Fair lock for overlapping vault paths/subtrees; independent subtrees may proceed concurrently. */
export class SubtreeLockManager {
  private readonly held: string[][] = [];
  private readonly waiting: Waiter[] = [];

  acquire(inputPaths: string[]): Promise<() => void> {
    const paths = [...new Set(inputPaths.map(normalizeVaultPath))].sort();
    if (!paths.length) throw new Error('at least one lock path is required');
    return new Promise((resolve) => {
      this.waiting.push({ paths, resolve });
      this.drain();
    });
  }

  async withLock<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(paths);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private drain(): void {
    // Preserve order among conflicting waiters while allowing independent work through.
    for (let index = 0; index < this.waiting.length;) {
      const waiter = this.waiting[index]!;
      const earlierConflict = this.waiting.slice(0, index).some((earlier) => overlapsAny(earlier.paths, waiter.paths));
      if (earlierConflict || this.held.some((held) => overlapsAny(held, waiter.paths))) {
        index += 1;
        continue;
      }
      this.waiting.splice(index, 1);
      this.held.push(waiter.paths);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        const heldIndex = this.held.indexOf(waiter.paths);
        if (heldIndex >= 0) this.held.splice(heldIndex, 1);
        this.drain();
      });
    }
  }
}

export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function overlapsAny(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => overlaps(a, b)));
}

function overlaps(left: string, right: string): boolean {
  const a = left.toLocaleLowerCase('en-US');
  const b = right.toLocaleLowerCase('en-US');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

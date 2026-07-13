import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SyncEventSchema, type SyncEvent } from '@picassio/sync-core';
import { AtomicJsonStore, CorruptSyncMetadataError, ensureSyncStorage } from './storage.js';

const SEGMENT_SCHEMA_VERSION = 1;
const SegmentSchema = z.object({
  schemaVersion: z.literal(SEGMENT_SCHEMA_VERSION),
  segment: z.number().int().positive(),
  firstSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  lastSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sealed: z.boolean(),
  eventCount: z.number().int().min(0),
  events: z.array(SyncEventSchema),
}).strict().superRefine((segment, ctx) => {
  if (segment.eventCount !== segment.events.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['eventCount'], message: 'eventCount does not match events' });
  }
  if (segment.events.length === 0) {
    if (segment.firstSequence !== 0 || segment.lastSequence !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'empty segment sequence bounds must be zero' });
    }
    return;
  }
  if (segment.firstSequence !== segment.events[0]?.sequence || segment.lastSequence !== segment.events.at(-1)?.sequence) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'segment sequence bounds do not match events' });
  }
  for (let index = 1; index < segment.events.length; index += 1) {
    if (segment.events[index]!.sequence !== segment.events[index - 1]!.sequence + 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index], message: 'segment events must be contiguous' });
    }
  }
});
type Segment = z.infer<typeof SegmentSchema>;
export interface JournalSegmentInfo {
  segment: number;
  firstSequence: number;
  lastSequence: number;
  eventCount: number;
  sealed: boolean;
  file: string;
}

export class JournalStore {
  private queue: Promise<void> = Promise.resolve();
  private replayCache: SyncEvent[] | null = null;

  constructor(private readonly dataDir: string, private readonly maxEventsPerSegment = 500) {
    if (!Number.isInteger(maxEventsPerSegment) || maxEventsPerSegment < 1) throw new Error('invalid segment limit');
  }

  append(eventInput: SyncEvent): Promise<void> {
    const result = this.queue.then(() => this.appendImpl(eventInput));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async appendImpl(eventInput: SyncEvent): Promise<void> {
    const event = SyncEventSchema.parse(eventInput);
    const segments = await this.listSegments();
    let number = segments.at(-1) ?? 1;
    let store = await this.segmentStore(number);
    let active = await store.read();
    if (!active) active = emptySegment(number);
    if (active.sealed || active.events.length >= this.maxEventsPerSegment) {
      if (!active.sealed) await store.write({ ...active, sealed: true });
      number += 1;
      store = await this.segmentStore(number);
      active = emptySegment(number);
    }
    const expected = active.events.length
      ? active.lastSequence + 1
      : await this.expectedSequenceBefore(number, segments);
    if (event.sequence !== expected) throw new Error(`journal sequence must be ${expected}, got ${event.sequence}`);
    const events = [...active.events, event];
    await store.write({
      ...active,
      firstSequence: events[0]!.sequence,
      lastSequence: event.sequence,
      eventCount: events.length,
      events,
    });
    if (this.replayCache) this.replayCache.push(event);
  }

  async replay(after = 0): Promise<SyncEvent[]> {
    if (!this.replayCache) {
      const numbers = await this.listSegments();
      const events: SyncEvent[] = [];
      let previous = 0;
      for (const number of numbers) {
        const segment = await (await this.segmentStore(number)).read();
        if (!segment) throw new CorruptSyncMetadataError(this.segmentFile(number), 'listed segment disappeared');
        for (const event of segment.events) {
          if (previous > 0 && event.sequence !== previous + 1) {
            throw new CorruptSyncMetadataError(this.segmentFile(number), `journal gap ${previous} → ${event.sequence}`);
          }
          previous = event.sequence;
          events.push(event);
        }
      }
      this.replayCache = events;
    }
    return this.replayCache.filter((event) => event.sequence > after);
  }

  async segments(): Promise<JournalSegmentInfo[]> {
    const result: JournalSegmentInfo[] = [];
    for (const number of await this.listSegments()) {
      const segment = await (await this.segmentStore(number)).read();
      if (!segment) throw new CorruptSyncMetadataError(this.segmentFile(number), 'listed segment disappeared');
      result.push({
        segment: number,
        firstSequence: segment.firstSequence,
        lastSequence: segment.lastSequence,
        eventCount: segment.eventCount,
        sealed: segment.sealed,
        file: this.segmentFile(number),
      });
    }
    return result;
  }

  async earliestSequence(): Promise<number | null> {
    return (await this.segments()).find((segment) => segment.eventCount > 0)?.firstSequence ?? null;
  }

  async compactThrough(sequence: number, backupDirectory: string): Promise<number[]> {
    const segments = await this.segments();
    const activeNumber = segments.at(-1)?.segment;
    const removable = segments.filter(
      (segment) => segment.segment !== activeNumber && segment.sealed && segment.eventCount > 0 && segment.lastSequence <= sequence,
    );
    if (!removable.length) return [];
    await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    for (const segment of removable) {
      await fs.copyFile(segment.file, path.join(backupDirectory, path.basename(segment.file)));
    }
    await fsyncDirectory(backupDirectory);
    for (const segment of removable) {
      await fs.unlink(segment.file);
      await fs.rm(`${segment.file}.bak`, { force: true });
    }
    await fsyncDirectory(path.dirname(removable[0]!.file));
    if (this.replayCache) this.replayCache = this.replayCache.filter((event) => event.sequence > sequence);
    return removable.map((segment) => segment.segment);
  }

  async latestSequence(): Promise<number> {
    const numbers = await this.listSegments();
    if (!numbers.length) return 0;
    const segment = await (await this.segmentStore(numbers.at(-1)!)).read();
    return segment?.lastSequence ?? 0;
  }

  async sealActive(): Promise<void> {
    const numbers = await this.listSegments();
    if (!numbers.length) return;
    const store = await this.segmentStore(numbers.at(-1)!);
    const segment = await store.read();
    if (segment && !segment.sealed) await store.write({ ...segment, sealed: true });
  }

  private async expectedSequenceBefore(number: number, known: number[]): Promise<number> {
    const previousNumber = [...known].filter((value) => value < number).at(-1);
    if (!previousNumber) return 1;
    const previous = await (await this.segmentStore(previousNumber)).read();
    if (!previous) throw new CorruptSyncMetadataError(this.segmentFile(previousNumber), 'previous segment missing');
    return previous.lastSequence + 1;
  }

  private async listSegments(): Promise<number[]> {
    const paths = await ensureSyncStorage(this.dataDir);
    const names = await fs.readdir(paths.journal);
    return names
      .map((name) => name.match(/^(\d{8})\.json$/)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number)
      .sort((a, b) => a - b);
  }

  private async segmentStore(number: number): Promise<AtomicJsonStore<Segment>> {
    await ensureSyncStorage(this.dataDir);
    return new AtomicJsonStore(this.segmentFile(number), SegmentSchema);
  }

  private segmentFile(number: number): string {
    return path.join(this.dataDir, 'sync', 'journal', `${String(number).padStart(8, '0')}.json`);
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); }
  catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { await handle?.close(); }
}

function emptySegment(segment: number): Segment {
  return { schemaVersion: SEGMENT_SCHEMA_VERSION, segment, firstSequence: 0, lastSequence: 0, sealed: false, eventCount: 0, events: [] };
}

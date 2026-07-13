import path from 'node:path';
import { z } from 'zod';
import { SyncEventSchema, type SyncEvent } from '@webobsidian/sync-core';
import { AtomicJsonStore, ensureSyncStorage } from './storage.js';

const DERIVED_QUEUE_SCHEMA_VERSION = 1;
const StateSchema = z.object({
  schemaVersion: z.literal(DERIVED_QUEUE_SCHEMA_VERSION),
  appliedSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  pending: z.array(SyncEventSchema),
  failedAttempts: z.number().int().min(0),
  lastError: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
type State = z.infer<typeof StateSchema>;

export class DerivedEventQueue {
  private state: State | null = null;
  private store: AtomicJsonStore<State> | null = null;
  private processing: Promise<void> | null = null;

  constructor(private readonly dataDir: string) {}

  async initializeAt(sequence: number): Promise<void> {
    const existing = await this.load(false);
    if (existing) return;
    await this.write({
      schemaVersion: DERIVED_QUEUE_SCHEMA_VERSION,
      appliedSequence: sequence,
      pending: [], failedAttempts: 0, lastError: null,
      updatedAt: new Date().toISOString(),
    });
  }

  async enqueue(event: SyncEvent): Promise<void> {
    const state = await this.required();
    if (event.sequence <= state.appliedSequence || state.pending.some((item) => item.eventId === event.eventId)) return;
    const expected = state.pending.at(-1)?.sequence !== undefined
      ? state.pending.at(-1)!.sequence + 1
      : state.appliedSequence + 1;
    if (event.sequence !== expected) throw new Error(`derived queue gap: expected ${expected}, got ${event.sequence}`);
    await this.write({ ...state, pending: [...state.pending, event], updatedAt: new Date().toISOString() });
  }

  process(handler: (event: SyncEvent) => Promise<void>): Promise<void> {
    if (this.processing) return this.processing;
    this.processing = this.processLoop(handler).finally(() => { this.processing = null; });
    return this.processing;
  }

  status(): { appliedSequence: number; pending: number; failedAttempts: number; lastError: string | null } {
    const state = this.state;
    return {
      appliedSequence: state?.appliedSequence ?? 0,
      pending: state?.pending.length ?? 0,
      failedAttempts: state?.failedAttempts ?? 0,
      lastError: state?.lastError ?? null,
    };
  }

  private async processLoop(handler: (event: SyncEvent) => Promise<void>): Promise<void> {
    while (true) {
      const state = await this.required();
      const event = state.pending[0];
      if (!event) return;
      try {
        await handler(event);
        await this.write({
          ...state,
          appliedSequence: event.sequence,
          pending: state.pending.slice(1),
          failedAttempts: 0,
          lastError: null,
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        await this.write({
          ...state,
          failedAttempts: state.failedAttempts + 1,
          lastError: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        });
        throw error;
      }
    }
  }

  private async required(): Promise<State> {
    const state = await this.load(true);
    if (!state) throw new Error('derived queue is not initialized');
    return state;
  }

  private async load(required: boolean): Promise<State | null> {
    if (this.state) return this.state;
    const paths = await ensureSyncStorage(this.dataDir);
    this.store = new AtomicJsonStore(path.join(paths.root, 'derived-queue.json'), StateSchema);
    this.state = await this.store.read();
    if (required && !this.state) throw new Error('derived queue is not initialized');
    return this.state;
  }

  private async write(state: State): Promise<void> {
    if (!this.store) await this.load(false);
    await this.store!.write(state);
    this.state = state;
  }
}

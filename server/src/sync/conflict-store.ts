import path from 'node:path';
import { z } from 'zod';
import { ConflictSchema, OperationResultSchema, type Conflict, type OperationResult } from '@webobsidian/sync-core';
import { AtomicJsonStore, ensureSyncStorage } from './storage.js';

const CONFLICT_SCHEMA_VERSION = 1;
const ResolutionSchema = z.object({
  conflictId: z.string().min(16),
  idempotencyKey: z.string().min(16).max(256),
  resolution: z.enum(['keep-server', 'keep-client', 'merged', 'copy']),
  result: OperationResultSchema.optional(),
  resolvedAt: z.string().datetime({ offset: true }),
}).strict();
type ResolutionRecord = z.infer<typeof ResolutionSchema>;
const ConflictStateSchema = z.object({
  schemaVersion: z.literal(CONFLICT_SCHEMA_VERSION),
  conflicts: z.array(ConflictSchema),
  resolutions: z.array(ResolutionSchema),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
type ConflictState = z.infer<typeof ConflictStateSchema>;

export class ConflictStore {
  private state: ConflictState | null = null;
  private store: AtomicJsonStore<ConflictState> | null = null;

  constructor(private readonly dataDir: string) {}

  async upsert(conflictInput: Conflict): Promise<Conflict> {
    const conflict = ConflictSchema.parse(conflictInput);
    const state = await this.load();
    const existing = state.conflicts.find((item) => item.conflictId === conflict.conflictId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(conflict)) throw new Error(`conflict ${conflict.conflictId} changed during retry`);
      return existing;
    }
    await this.write([...state.conflicts, conflict]);
    return conflict;
  }

  async list(status?: Conflict['status']): Promise<Conflict[]> {
    const conflicts = (await this.load()).conflicts;
    return conflicts.filter((item) => status === undefined || item.status === status);
  }

  async get(conflictId: string): Promise<Conflict | null> {
    return (await this.load()).conflicts.find((item) => item.conflictId === conflictId) ?? null;
  }

  async resolution(conflictId: string, idempotencyKey: string): Promise<ResolutionRecord | null> {
    return (await this.load()).resolutions.find(
      (record) => record.conflictId === conflictId && record.idempotencyKey === idempotencyKey,
    ) ?? null;
  }

  async resolve(
    conflictId: string,
    idempotencyKey: string,
    resolution: ResolutionRecord['resolution'],
    result?: OperationResult,
    resolvedAt = new Date(),
  ): Promise<{ conflict: Conflict; resolution: ResolutionRecord }> {
    const state = await this.load();
    const existing = state.conflicts.find((item) => item.conflictId === conflictId);
    if (!existing) throw new Error(`unknown conflict ${conflictId}`);
    const duplicate = state.resolutions.find((item) => item.conflictId === conflictId && item.idempotencyKey === idempotencyKey);
    if (duplicate) return { conflict: existing, resolution: duplicate };
    if (existing.status === 'resolved') throw new Error('conflict was already resolved by another request');
    const resolved = ConflictSchema.parse({ ...existing, status: 'resolved', resolvedAt: resolvedAt.toISOString() });
    const resolutionRecord = ResolutionSchema.parse({
      conflictId, idempotencyKey, resolution, ...(result ? { result } : {}), resolvedAt: resolvedAt.toISOString(),
    });
    await this.write(
      state.conflicts.map((item) => item.conflictId === conflictId ? resolved : item),
      [...state.resolutions, resolutionRecord],
    );
    return { conflict: resolved, resolution: resolutionRecord };
  }

  private async load(): Promise<ConflictState> {
    if (this.state) return this.state;
    const paths = await ensureSyncStorage(this.dataDir);
    this.store = new AtomicJsonStore(path.join(paths.root, 'conflicts.json'), ConflictStateSchema);
    this.state = await this.store.read() ?? {
      schemaVersion: CONFLICT_SCHEMA_VERSION,
      conflicts: [], resolutions: [],
      updatedAt: new Date().toISOString(),
    };
    return this.state;
  }

  private async write(conflicts: Conflict[], resolutions?: ResolutionRecord[]): Promise<void> {
    await this.load();
    const state: ConflictState = {
      schemaVersion: CONFLICT_SCHEMA_VERSION,
      conflicts: conflicts.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      resolutions: resolutions ?? (await this.load()).resolutions,
      updatedAt: new Date().toISOString(),
    };
    await this.store!.write(state);
    this.state = state;
  }
}

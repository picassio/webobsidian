import path from 'node:path';
import { z } from 'zod';
import { IdSchema, Sha256Schema, VaultPathSchema } from '@webobsidian/sync-core';
import { AtomicJsonStore, ensureSyncStorage } from './storage.js';

const TRASH_SCHEMA_VERSION = 1;
export const TrashRecordSchema = z.object({
  trashId: IdSchema,
  transactionId: IdSchema,
  entryId: IdSchema,
  kind: z.enum(['file', 'directory']),
  originalPath: VaultPathSchema,
  trashPath: VaultPathSchema,
  deletedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hash: Sha256Schema.nullable(),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['trashed', 'restored', 'purged']),
  deletedAt: z.string().datetime({ offset: true }),
  restoredPath: VaultPathSchema.optional(),
  restoredAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type TrashRecord = z.infer<typeof TrashRecordSchema>;
const TrashStateSchema = z.object({
  schemaVersion: z.literal(TRASH_SCHEMA_VERSION),
  records: z.array(TrashRecordSchema),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
type TrashState = z.infer<typeof TrashStateSchema>;

export class TrashStore {
  private state: TrashState | null = null;
  private store: AtomicJsonStore<TrashState> | null = null;
  constructor(private readonly dataDir: string) {}

  async upsert(recordInput: TrashRecord): Promise<TrashRecord> {
    const record = TrashRecordSchema.parse(recordInput);
    const state = await this.load();
    const existing = state.records.find((item) => item.trashId === record.trashId);
    if (existing) return existing;
    await this.write([...state.records, record]);
    return record;
  }

  async list(status: TrashRecord['status'] = 'trashed'): Promise<TrashRecord[]> {
    return (await this.load()).records.filter((record) => record.status === status);
  }

  async get(trashId: string): Promise<TrashRecord | null> {
    return (await this.load()).records.find((record) => record.trashId === trashId) ?? null;
  }

  async findByPath(trashPath: string): Promise<TrashRecord | null> {
    return (await this.load()).records.find((record) => record.trashPath === trashPath && record.status === 'trashed') ?? null;
  }

  async findByEntry(entryId: string): Promise<TrashRecord | null> {
    return (await this.load()).records.find((record) => record.entryId === entryId && record.status === 'trashed') ?? null;
  }

  async markRestored(trashId: string, restoredPath: string, restoredAt = new Date()): Promise<TrashRecord> {
    const state = await this.load();
    const record = state.records.find((item) => item.trashId === trashId);
    if (!record) throw new Error(`unknown trash record ${trashId}`);
    if (record.status === 'restored') return record;
    const updated = TrashRecordSchema.parse({
      ...record, status: 'restored', restoredPath, restoredAt: restoredAt.toISOString(),
    });
    await this.write(state.records.map((item) => item.trashId === trashId ? updated : item));
    return updated;
  }

  async markPurged(trashId: string): Promise<TrashRecord> {
    const state = await this.load();
    const record = state.records.find((item) => item.trashId === trashId);
    if (!record) throw new Error(`unknown trash record ${trashId}`);
    if (record.status === 'purged') return record;
    const updated = TrashRecordSchema.parse({ ...record, status: 'purged' });
    await this.write(state.records.map((item) => item.trashId === trashId ? updated : item));
    return updated;
  }

  private async load(): Promise<TrashState> {
    if (this.state) return this.state;
    const paths = await ensureSyncStorage(this.dataDir);
    this.store = new AtomicJsonStore(path.join(paths.root, 'trash.json'), TrashStateSchema);
    this.state = await this.store.read() ?? { schemaVersion: TRASH_SCHEMA_VERSION, records: [], updatedAt: new Date().toISOString() };
    return this.state;
  }

  private async write(records: TrashRecord[]): Promise<void> {
    await this.load();
    const state: TrashState = { schemaVersion: TRASH_SCHEMA_VERSION, records, updatedAt: new Date().toISOString() };
    await this.store!.write(state);
    this.state = state;
  }
}

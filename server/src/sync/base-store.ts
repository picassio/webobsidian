import path from 'node:path';
import { z } from 'zod';
import { IdSchema, Sha256Schema } from '@picassio/sync-core';
import { AtomicJsonStore, ensureSyncStorage } from './storage.js';
import { BlobStore, type BlobInfo } from './blob-store.js';

const BASE_SCHEMA_VERSION = 1;
const MergeBaseSchema = z.object({
  entryId: IdSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hash: Sha256Schema,
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  eventSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  retainedAt: z.string().datetime({ offset: true }),
}).strict();
export type MergeBase = z.infer<typeof MergeBaseSchema>;
const BaseIndexSchema = z.object({
  schemaVersion: z.literal(BASE_SCHEMA_VERSION),
  bases: z.array(MergeBaseSchema),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
type BaseIndex = z.infer<typeof BaseIndexSchema>;

export interface BaseRetentionPolicy {
  now?: Date;
  maxAgeMs: number;
  maxPerEntry: number;
  protectedHashes?: ReadonlySet<string>;
}

export class MergeBaseStore {
  private readonly blobs: BlobStore;
  private store: AtomicJsonStore<BaseIndex> | null = null;
  private index: BaseIndex | null = null;

  constructor(private readonly dataDir: string, blobStore?: BlobStore) {
    this.blobs = blobStore ?? new BlobStore(dataDir);
  }

  async retainFile(input: Omit<MergeBase, 'retainedAt'>, source: string): Promise<MergeBase> {
    await this.blobs.putFile(source, input.hash, input.size);
    return this.retainMetadata(input);
  }

  async retain(
    input: Omit<MergeBase, 'retainedAt'>,
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<MergeBase> {
    await this.blobs.put(chunks, input.hash, input.size);
    return this.retainMetadata(input);
  }

  async get(entryId: string, revision: number): Promise<(MergeBase & BlobInfo) | null> {
    const index = await this.load();
    const base = index.bases.find((item) => item.entryId === entryId && item.revision === revision);
    if (!base) return null;
    const blob = await this.blobs.get(base.hash);
    if (!blob) throw new Error(`merge base blob missing: ${base.hash}`);
    return { ...base, ...blob };
  }

  async list(): Promise<MergeBase[]> {
    return [...(await this.load()).bases];
  }

  async prune(policy: BaseRetentionPolicy): Promise<{ removed: MergeBase[]; referencedHashes: Set<string> }> {
    if (!Number.isInteger(policy.maxPerEntry) || policy.maxPerEntry < 1 || policy.maxAgeMs < 0) {
      throw new Error('invalid merge-base retention policy');
    }
    const index = await this.load();
    const cutoff = (policy.now ?? new Date()).getTime() - policy.maxAgeMs;
    const rank = new Map<string, number>();
    const keep: MergeBase[] = [];
    const removed: MergeBase[] = [];
    for (const base of [...index.bases].sort((a, b) => b.revision - a.revision)) {
      const currentRank = rank.get(base.entryId) ?? 0;
      rank.set(base.entryId, currentRank + 1);
      const protectedByReference = policy.protectedHashes?.has(base.hash) ?? false;
      const expired = Date.parse(base.retainedAt) < cutoff;
      if (!protectedByReference && (expired || currentRank >= policy.maxPerEntry)) removed.push(base);
      else keep.push(base);
    }
    if (removed.length) await this.write(keep);
    return { removed, referencedHashes: new Set(keep.map((base) => base.hash)) };
  }

  async referencedHashes(): Promise<Set<string>> {
    return new Set((await this.load()).bases.map((base) => base.hash));
  }

  private async retainMetadata(input: Omit<MergeBase, 'retainedAt'>): Promise<MergeBase> {
    const index = await this.load();
    const base = MergeBaseSchema.parse({ ...input, retainedAt: new Date().toISOString() });
    const existing = index.bases.find((item) => item.entryId === base.entryId && item.revision === base.revision);
    if (existing) {
      if (existing.hash !== base.hash) throw new Error('merge base revision already has a different hash');
      return existing;
    }
    await this.write([...index.bases, base]);
    return base;
  }

  private async load(): Promise<BaseIndex> {
    if (this.index) return this.index;
    await ensureSyncStorage(this.dataDir);
    this.store = new AtomicJsonStore(path.join(this.dataDir, 'sync', 'bases', 'index.json'), BaseIndexSchema);
    this.index = await this.store.read() ?? { schemaVersion: BASE_SCHEMA_VERSION, bases: [], updatedAt: new Date().toISOString() };
    return this.index;
  }

  private async write(bases: MergeBase[]): Promise<void> {
    await this.load();
    const index: BaseIndex = { schemaVersion: BASE_SCHEMA_VERSION, bases, updatedAt: new Date().toISOString() };
    await this.store!.write(index);
    this.index = index;
  }
}

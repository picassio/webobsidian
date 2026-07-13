import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  ConflictSchema,
  OperationResultSchema,
  Sha256Schema,
  SyncEventSchema,
  VaultPathSchema,
  sha256Chunks,
  type Conflict,
  type OperationResult,
  type SyncEvent,
} from '@picassio/sync-core';
import { AtomicJsonStore, ensureSyncStorage } from './storage.js';

const INTENT_SCHEMA_VERSION = 1;
const StagedContentSchema = z.object({
  file: z.enum(['new.bin', 'previous.bin']),
  hash: Sha256Schema,
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
const IntentSchema = z.object({
  schemaVersion: z.literal(INTENT_SCHEMA_VERSION),
  transactionId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
  status: z.enum(['prepared', 'materialized']),
  event: SyncEventSchema,
  result: OperationResultSchema,
  clientSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  operationFingerprint: Sha256Schema,
  conflict: ConflictSchema.optional(),
  restoreTrashId: z.string().min(8).max(128).optional(),
  targetPath: VaultPathSchema,
  previousPath: VaultPathSchema.optional(),
  newContent: StagedContentSchema.nullable(),
  previousContent: StagedContentSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type TransactionIntent = z.infer<typeof IntentSchema>;

export interface PrepareIntentInput {
  event: SyncEvent;
  result: OperationResult;
  clientSequence: number;
  operationFingerprint: string;
  conflict?: Conflict;
  restoreTrashId?: string;
  targetPath: string;
  previousPath?: string;
  newContentSource?: string;
  previousContentSource?: string;
}

/** Durable write-ahead transaction staging. It does not mutate the vault or journal. */
export class TransactionIntentStore {
  constructor(private readonly dataDir: string) {}

  async prepare(input: PrepareIntentInput): Promise<TransactionIntent> {
    const event = SyncEventSchema.parse(input.event);
    const transactionId = `tx_${randomBytes(18).toString('base64url')}`;
    const directory = await this.intentDirectory(transactionId);
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
    try {
      const newContent = input.newContentSource
        ? await stageContent(input.newContentSource, path.join(directory, 'new.bin'), 'new.bin')
        : null;
      const previousContent = input.previousContentSource
        ? await stageContent(input.previousContentSource, path.join(directory, 'previous.bin'), 'previous.bin')
        : null;
      const now = new Date().toISOString();
      const intent = IntentSchema.parse({
        schemaVersion: INTENT_SCHEMA_VERSION,
        transactionId,
        status: 'prepared',
        event,
        result: input.result,
        clientSequence: input.clientSequence,
        operationFingerprint: input.operationFingerprint,
        ...(input.conflict ? { conflict: input.conflict } : {}),
        ...(input.restoreTrashId ? { restoreTrashId: input.restoreTrashId } : {}),
        targetPath: input.targetPath,
        ...(input.previousPath !== undefined ? { previousPath: input.previousPath } : {}),
        newContent,
        previousContent,
        createdAt: now,
        updatedAt: now,
      });
      await this.store(transactionId).write(intent);
      await fsyncDirectory(directory);
      return intent;
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async markMaterialized(transactionId: string): Promise<TransactionIntent> {
    const store = this.store(transactionId);
    const intent = await store.read();
    if (!intent) throw new Error(`unknown transaction ${transactionId}`);
    if (intent.status === 'materialized') return intent;
    const next = IntentSchema.parse({ ...intent, status: 'materialized', updatedAt: new Date().toISOString() });
    await store.write(next);
    return next;
  }

  async list(): Promise<TransactionIntent[]> {
    const paths = await ensureSyncStorage(this.dataDir);
    const children = await fs.readdir(paths.transactions, { withFileTypes: true });
    const intents: TransactionIntent[] = [];
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!child.isDirectory() || !/^tx_[A-Za-z0-9_-]+$/.test(child.name)) continue;
      const intent = await this.store(child.name).read();
      if (!intent) throw new Error(`transaction directory ${child.name} has no intent`);
      intents.push(intent);
    }
    return intents;
  }

  async remove(transactionId: string): Promise<void> {
    const directory = await this.intentDirectory(transactionId);
    await fs.rm(directory, { recursive: true, force: true });
    await fsyncDirectory(path.dirname(directory));
  }

  contentPath(intent: TransactionIntent, which: 'new' | 'previous'): string | null {
    const content = which === 'new' ? intent.newContent : intent.previousContent;
    return content ? path.join(this.dataDir, 'sync', 'transactions', intent.transactionId, content.file) : null;
  }

  private store(transactionId: string): AtomicJsonStore<TransactionIntent> {
    if (!/^tx_[A-Za-z0-9_-]+$/.test(transactionId)) throw new Error('invalid transaction id');
    return new AtomicJsonStore(path.join(this.dataDir, 'sync', 'transactions', transactionId, 'intent.json'), IntentSchema);
  }

  private async intentDirectory(transactionId: string): Promise<string> {
    if (!/^tx_[A-Za-z0-9_-]+$/.test(transactionId)) throw new Error('invalid transaction id');
    const paths = await ensureSyncStorage(this.dataDir);
    return path.join(paths.transactions, transactionId);
  }
}

async function stageContent(source: string, destination: string, file: 'new.bin' | 'previous.bin') {
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  await pipeline(createReadStream(source), output);
  const handle = await fs.open(destination, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const stat = await fs.stat(destination);
  return { file, hash: await sha256Chunks(createReadStream(destination)), size: stat.size };
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    await handle?.close();
  }
}

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, Sha256Schema } from '@webobsidian/sync-core';
import { BlobStore } from './blob-store.js';
import { AsyncMutex } from './locks.js';
import { AtomicJsonStore, ensureSyncStorage } from './storage.js';

const UPLOAD_SCHEMA_VERSION = 1;
const UploadSchema = z.object({
  schemaVersion: z.literal(UPLOAD_SCHEMA_VERSION),
  uploadId: IdSchema,
  deviceId: IdSchema,
  hash: Sha256Schema,
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  chunkSize: z.number().int().positive(),
  partCount: z.number().int().positive(),
  receivedParts: z.array(z.number().int().min(0)),
  deduplicated: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
type Upload = z.infer<typeof UploadSchema>;

export class UploadStore {
  private readonly mutex = new AsyncMutex();
  private readonly blobs: BlobStore;
  constructor(
    private readonly dataDir: string,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly quotaBytes = 10 * 1024 * 1024 * 1024,
  ) { this.blobs = new BlobStore(dataDir); }

  async create(deviceId: string, hash: string, size: number, chunkSize: number) {
    return this.mutex.run(async () => {
      await this.cleanupExpired();
      const existingBlob = await this.blobs.get(hash);
      const active = await this.list();
      const reusable = active.find((item) => item.deviceId === deviceId && item.hash === hash && item.size === size && item.chunkSize === chunkSize);
      if (reusable) return this.describe(reusable);
      const reserved = active.filter((item) => !item.deduplicated).reduce((total, item) => total + item.size, 0);
      if (!existingBlob && reserved + size > this.quotaBytes) throw new Error('upload quota exceeded');
      const now = new Date();
      const upload: Upload = UploadSchema.parse({
        schemaVersion: UPLOAD_SCHEMA_VERSION,
        uploadId: `upload_${randomBytes(18).toString('base64url')}`,
        deviceId, hash, size, chunkSize,
        partCount: Math.ceil(size / chunkSize),
        receivedParts: [],
        deduplicated: Boolean(existingBlob),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      });
      await fs.mkdir(this.directory(upload.uploadId), { recursive: true, mode: 0o700 });
      await this.store(upload.uploadId).write(upload);
      return this.describe(upload);
    });
  }

  async putPart(deviceId: string, uploadId: string, part: number, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    await this.mutex.run(async () => {
      const upload = await this.required(deviceId, uploadId);
      if (upload.deduplicated) return;
      if (!Number.isInteger(part) || part < 0 || part >= upload.partCount) throw new Error('invalid upload part');
      const expected = part === upload.partCount - 1 ? upload.size - part * upload.chunkSize : upload.chunkSize;
      const target = this.partFile(uploadId, part);
      const temporary = `${target}.tmp-${randomBytes(6).toString('hex')}`;
      const handle = await fs.open(temporary, 'wx', 0o600);
      let size = 0;
      try {
        for await (const chunk of chunks) {
          size += chunk.byteLength;
          if (size > expected) throw new Error('upload part exceeds expected size');
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
            offset += bytesWritten;
          }
        }
        if (size !== expected) throw new Error(`upload part size mismatch: expected ${expected}, got ${size}`);
        await handle.sync();
      } catch (error) {
        await handle.close();
        await fs.rm(temporary, { force: true });
        throw error;
      }
      await handle.close();
      await fs.rename(temporary, target);
      const updated = UploadSchema.parse({ ...upload, receivedParts: [...new Set([...upload.receivedParts, part])].sort((a, b) => a - b) });
      await this.store(uploadId).write(updated);
    });
  }

  async complete(deviceId: string, uploadId: string) {
    return this.mutex.run(async () => {
      const upload = await this.required(deviceId, uploadId);
      if (upload.deduplicated) {
        await fs.rm(this.directory(uploadId), { recursive: true, force: true });
        return { hash: upload.hash, size: upload.size, deduplicated: true };
      }
      const missing = this.describe(upload).missingParts;
      if (missing.length) throw new Error(`upload has missing parts: ${missing.join(',')}`);
      async function* parts(store: UploadStore) {
        for (let part = 0; part < upload.partCount; part += 1) yield* createReadStream(store.partFile(uploadId, part));
      }
      await this.blobs.put(parts(this), upload.hash, upload.size);
      await fs.rm(this.directory(uploadId), { recursive: true, force: true });
      return { hash: upload.hash, size: upload.size, deduplicated: false };
    });
  }

  async cleanupExpired(now = new Date()): Promise<number> {
    const uploads = await this.list();
    const expired = uploads.filter((upload) => Date.parse(upload.expiresAt) <= now.getTime());
    for (const upload of expired) await fs.rm(this.directory(upload.uploadId), { recursive: true, force: true });
    return expired.length;
  }

  private describe(upload: Upload) {
    const received = new Set(upload.receivedParts);
    return {
      uploadId: upload.uploadId,
      missingParts: upload.deduplicated ? [] : Array.from({ length: upload.partCount }, (_, part) => part).filter((part) => !received.has(part)),
      expiresAt: upload.expiresAt,
    };
  }

  private async required(deviceId: string, uploadId: string): Promise<Upload> {
    const upload = await this.store(uploadId).read();
    if (!upload || upload.deviceId !== deviceId || Date.parse(upload.expiresAt) <= Date.now()) throw new Error('upload is missing, expired, or owned by another device');
    return upload;
  }

  private async list(): Promise<Upload[]> {
    const paths = await ensureSyncStorage(this.dataDir);
    const result: Upload[] = [];
    for (const child of await fs.readdir(paths.uploads, { withFileTypes: true })) {
      if (!child.isDirectory() || !child.name.startsWith('upload_')) continue;
      const upload = await this.store(child.name).read();
      if (upload) result.push(upload);
    }
    return result;
  }

  private store(uploadId: string) {
    IdSchema.parse(uploadId);
    return new AtomicJsonStore(path.join(this.directory(uploadId), 'state.json'), UploadSchema);
  }
  private directory(uploadId: string) { return path.join(this.dataDir, 'sync', 'uploads', uploadId); }
  private partFile(uploadId: string, part: number) { return path.join(this.directory(uploadId), `${String(part).padStart(8, '0')}.part`); }
}

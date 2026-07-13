import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z, type ZodType } from 'zod';
import { sha256Text } from '@webobsidian/sync-core';

const ENVELOPE_VERSION = 1;

const EnvelopeSchema = z.object({
  envelopeVersion: z.literal(ENVELOPE_VERSION),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.unknown(),
}).strict();

export interface SyncStoragePaths {
  root: string;
  journal: string;
  transactions: string;
  bases: string;
  blobs: string;
  uploads: string;
}

export function syncStoragePaths(dataDir: string): SyncStoragePaths {
  const root = path.join(dataDir, 'sync');
  return {
    root,
    journal: path.join(root, 'journal'),
    transactions: path.join(root, 'transactions'),
    bases: path.join(root, 'bases'),
    blobs: path.join(root, 'blobs', 'sha256'),
    uploads: path.join(root, 'uploads'),
  };
}

export async function ensureSyncStorage(dataDir: string): Promise<SyncStoragePaths> {
  const paths = syncStoragePaths(dataDir);
  await Promise.all(Object.values(paths).map((directory) => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
  return paths;
}

export class CorruptSyncMetadataError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'CorruptSyncMetadataError';
  }
}

/** Checksummed, mode-0600, temp+fsync+rename JSON store with previous-value backup. */
export class AtomicJsonStore<T> {
  constructor(public readonly file: string, private readonly schema: ZodType<T>) {}

  async read(): Promise<T | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const envelope = EnvelopeSchema.parse(JSON.parse(raw));
      const payloadJson = JSON.stringify(envelope.payload);
      if (sha256Text(payloadJson) !== envelope.checksum) {
        throw new CorruptSyncMetadataError(this.file, 'checksum mismatch');
      }
      return this.schema.parse(envelope.payload);
    } catch (error) {
      if (error instanceof CorruptSyncMetadataError) throw error;
      throw new CorruptSyncMetadataError(this.file, error instanceof Error ? error.message : 'invalid JSON');
    }
  }

  async write(payload: T): Promise<void> {
    const validated = this.schema.parse(payload);
    const payloadJson = JSON.stringify(validated);
    const body = `${JSON.stringify({ envelopeVersion: ENVELOPE_VERSION, checksum: sha256Text(payloadJson), payload: validated }, null, 2)}\n`;
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp-${randomBytes(6).toString('hex')}`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.copyFile(this.file, `${this.file}.bak`);
      await fs.chmod(`${this.file}.bak`, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await fs.rm(temp, { force: true });
        throw error;
      }
    }
    await fs.rename(temp, this.file);
    await fs.chmod(this.file, 0o600);
    await fsyncDirectory(path.dirname(this.file));
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Directory fsync is unsupported on some non-POSIX adapters; file fsync+rename
    // still provides the strongest available guarantee there.
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(code ?? '')) throw error;
  } finally {
    await handle?.close();
  }
}

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fs, type ReadStream } from 'node:fs';
import path from 'node:path';
import { Sha256Schema, timingSafeHexEqual } from '@picassio/sync-core';
import { ensureSyncStorage } from './storage.js';

export interface BlobInfo { hash: string; size: number; file: string }
export interface BlobRange { stream: ReadStream; size: number; start: number; end: number; length: number }

/** Content-addressed immutable blob storage; writes and reads are bounded-memory streams. */
export class BlobStore {
  constructor(private readonly dataDir: string, private readonly maxBlobBytes = 2 * 1024 * 1024 * 1024) {}

  async put(
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    expectedHash: string,
    expectedSize: number,
  ): Promise<BlobInfo> {
    const hash = Sha256Schema.parse(expectedHash);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > this.maxBlobBytes) {
      throw new Error(`blob size exceeds limit (${this.maxBlobBytes})`);
    }
    const paths = await ensureSyncStorage(this.dataDir);
    const destination = this.file(hash);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = path.join(paths.uploads, `.blob-${randomBytes(16).toString('hex')}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    const digest = createHash('sha256');
    let size = 0;
    try {
      for await (const value of chunks) {
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        size += chunk.byteLength;
        if (size > expectedSize || size > this.maxBlobBytes) throw new Error('blob size mismatch or limit exceeded');
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          offset += bytesWritten;
        }
      }
      if (size !== expectedSize) throw new Error(`blob size mismatch: expected ${expectedSize}, got ${size}`);
      const actualHash = digest.digest('hex');
      if (!timingSafeHexEqual(actualHash, hash)) throw new Error(`blob hash mismatch: expected ${hash}, got ${actualHash}`);
      await handle.sync();
    } catch (error) {
      await handle.close();
      await fs.rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    try {
      await fs.link(temporary, destination);
      await fs.chmod(destination, 0o600);
      await fsyncDirectory(path.dirname(destination));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await fs.rm(temporary, { force: true });
        throw error;
      }
      const existing = await fs.stat(destination);
      if (existing.size !== size) {
        await fs.rm(temporary, { force: true });
        throw new Error(`content-address collision for ${hash}`);
      }
    }
    await fs.rm(temporary, { force: true });
    return { hash, size, file: destination };
  }

  async putFile(source: string, expectedHash: string, expectedSize: number): Promise<BlobInfo> {
    return this.put(createReadStream(source), expectedHash, expectedSize);
  }

  async get(hashInput: string): Promise<BlobInfo | null> {
    const hash = Sha256Schema.parse(hashInput);
    const file = this.file(hash);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return null;
      return { hash, size: stat.size, file };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async range(hashInput: string, start = 0, endInclusive?: number): Promise<BlobRange> {
    const info = await this.get(hashInput);
    if (!info) throw new Error('blob not found');
    if (info.size === 0 && start === 0 && endInclusive === undefined) {
      return { stream: createReadStream(info.file), size: 0, start: 0, end: -1, length: 0 };
    }
    const end = endInclusive ?? info.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= info.size) {
      throw new RangeError(`invalid blob range ${start}-${end}/${info.size}`);
    }
    return { stream: createReadStream(info.file, { start, end }), size: info.size, start, end, length: end - start + 1 };
  }

  async list(): Promise<BlobInfo[]> {
    const paths = await ensureSyncStorage(this.dataDir);
    const result: BlobInfo[] = [];
    for (const prefix of await fs.readdir(paths.blobs, { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const directory = path.join(paths.blobs, prefix.name);
      for (const child of await fs.readdir(directory, { withFileTypes: true })) {
        if (!child.isFile() || !/^[a-f0-9]{62}$/.test(child.name)) continue;
        const hash = `${prefix.name}${child.name}`;
        const file = path.join(directory, child.name);
        result.push({ hash, size: (await fs.stat(file)).size, file });
      }
    }
    return result.sort((a, b) => a.hash.localeCompare(b.hash));
  }

  async removeUnreferenced(referenced: ReadonlySet<string>, olderThan: Date): Promise<string[]> {
    const paths = await ensureSyncStorage(this.dataDir);
    const removed: string[] = [];
    const prefixes = await fs.readdir(paths.blobs, { withFileTypes: true });
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const directory = path.join(paths.blobs, prefix.name);
      for (const child of await fs.readdir(directory, { withFileTypes: true })) {
        const hash = `${prefix.name}${child.name}`;
        if (!child.isFile() || !/^[a-f0-9]{62}$/.test(child.name) || referenced.has(hash)) continue;
        const file = path.join(directory, child.name);
        const stat = await fs.stat(file);
        if (stat.mtime < olderThan) {
          await fs.unlink(file);
          removed.push(hash);
        }
      }
      if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory);
    }
    return removed.sort();
  }

  file(hashInput: string): string {
    const hash = Sha256Schema.parse(hashInput);
    return path.join(this.dataDir, 'sync', 'blobs', 'sha256', hash.slice(0, 2), hash.slice(2));
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); }
  catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { await handle?.close(); }
}

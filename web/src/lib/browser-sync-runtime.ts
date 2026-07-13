import { DEFAULT_LIMITS, normalizeVaultPath, sha256Chunks, sha256Text, type SyncOperation } from '@picassio/sync-core';
import { api } from './api';
import { BrowserLocalSyncAdapter } from './browser-sync-adapter';
import { IndexedDbSyncPersistence, type PendingAttachment, type SyncPersistence } from './sync-db';
import { BrowserSyncEngine, HttpSyncTransport } from './sync-engine';
import { registerSyncSaveHandler, useStore, type DocumentState } from './store';

let activeEngine: BrowserSyncEngine | null = null;
let activeUpload: {
  persistence: IndexedDbSyncPersistence;
  transport: HttpSyncTransport;
  engine: BrowserSyncEngine;
  knownDirectories: Set<string>;
} | null = null;
let uploadPreparation: Promise<void> = Promise.resolve();

export async function initializeBrowserSync(): Promise<() => void> {
  const persistence = new IndexedDbSyncPersistence();
  const legacyToken = await persistence.getLegacyDeviceToken();
  if (legacyToken) {
    try {
      await api.upgradeBrowserSyncDevice(legacyToken);
      await persistence.clearLegacyDeviceToken();
    } catch {
      useStore.getState().setSyncStatus('error', 0, 0);
      return () => {};
    }
  }
  const device = await persistence.getDevice();
  if (!device) {
    useStore.getState().setSyncStatus('disabled', 0, 0);
    return () => {};
  }
  const transport = new HttpSyncTransport();
  const adapter = new BrowserLocalSyncAdapter(persistence, (event) => transport.fileText(event));
  const engine = new BrowserSyncEngine(persistence, transport, adapter, (status, lag) => {
    useStore.getState().setSyncStatus(status, lag);
    if (status === 'synced') void flushAttachments(persistence, transport, engine).catch(() => {});
  });
  activeEngine?.stop();
  activeEngine = engine;
  activeUpload = {
    persistence,
    transport,
    engine,
    knownDirectories: new Set((await persistence.entries()).filter((entry) => !entry.deleted).map((entry) => entry.path.toLocaleLowerCase('en-US'))),
  };

  registerSyncSaveHandler(async (document: DocumentState) => {
    await flushAttachments(persistence, transport, engine);
    const size = new TextEncoder().encode(document.content).byteLength;
    const clientSequence = await persistence.takeClientSequence();
    const idempotencyKey = `web-save-${crypto.randomUUID()}`;
    const hash = sha256Text(document.content);
    const content = size <= DEFAULT_LIMITS.inlineTextBytes
      ? { hash, size, inlineText: document.content }
      : { hash, size, blobHash: hash };
    if (size > DEFAULT_LIMITS.inlineTextBytes) await transport.uploadText(document.content, hash);
    let operation: SyncOperation;
    if (document.entryId && document.revision !== null) {
      operation = {
        operation: 'modify', entryId: document.entryId,
        baseRevision: document.revision, clientSequence, idempotencyKey, content,
      };
    } else {
      operation = {
        operation: 'create', path: document.path, kind: 'file',
        clientSequence, idempotencyKey, content,
      };
    }
    await engine.queue(operation);
    return true;
  });

  const conflicts = await api.syncConflicts().catch(() => ({ conflicts: [] }));
  useStore.getState().setSyncStatus('syncing', 0, conflicts.conflicts.filter((item) => item.status === 'unresolved').length);
  await engine.start().catch(() => {});
  return () => {
    if (activeEngine === engine) activeEngine = null;
    if (activeUpload?.engine === engine) activeUpload = null;
    registerSyncSaveHandler(null);
    engine.stop();
  };
}

export async function uploadBrowserFile(file: File, dir = 'attachments'): Promise<{ path: string; size: number }> {
  if (!activeUpload) return api.upload(file, dir);
  const safeName = file.name.normalize('NFC').replace(/[\\/\u0000-\u001f]/g, '-').trim();
  const rawDirectory = dir.replace(/^\/+|\/+$/g, '');
  const directory = rawDirectory ? normalizeVaultPath(rawDirectory) : '';
  const path = normalizeVaultPath(directory ? `${directory}/${safeName}` : safeName);
  const hash = await sha256Chunks(blobChunks(file));
  return serializeUploadPreparation(async () => {
    const upload = activeUpload;
    if (!upload) return api.upload(file, dir);
    await ensureUploadDirectories(upload.persistence, upload.engine, directory, upload.knownDirectories);
    const attachment: PendingAttachment = {
      idempotencyKey: `web-upload-${crypto.randomUUID()}`,
      clientSequence: await upload.persistence.takeClientSequence(),
      path, hash, size: file.size, blob: file, createdAt: new Date().toISOString(),
    };
    await upload.persistence.putAttachment(attachment);
    await flushAttachments(upload.persistence, upload.transport, upload.engine).catch(() => {});
    return { path, size: file.size };
  });
}

export async function ensureUploadDirectories(
  persistence: SyncPersistence,
  engine: Pick<BrowserSyncEngine, 'queue'>,
  directory: string,
  knownDirectories = new Set<string>(),
): Promise<void> {
  if (!directory) return;
  const existing = new Set((await persistence.entries()).filter((entry) => !entry.deleted).map((entry) => entry.path.toLocaleLowerCase('en-US')));
  const queued = new Set((await persistence.operations()).flatMap((operation) =>
    operation.operation === 'mkdir' ? [operation.path.toLocaleLowerCase('en-US')] : [],
  ));
  const components = directory.split('/');
  let current = '';
  for (const component of components) {
    current = current ? `${current}/${component}` : component;
    const key = current.toLocaleLowerCase('en-US');
    if (existing.has(key) || queued.has(key) || knownDirectories.has(key)) continue;
    knownDirectories.add(key);
    try {
      await engine.queue({
        operation: 'mkdir', path: current, kind: 'directory',
        clientSequence: await persistence.takeClientSequence(),
        idempotencyKey: `web-upload-dir-${crypto.randomUUID()}`,
      });
      queued.add(key);
    } catch (error) {
      knownDirectories.delete(key);
      throw error;
    }
  }
}

function serializeUploadPreparation<T>(task: () => Promise<T>): Promise<T> {
  const run = uploadPreparation.then(task, task);
  uploadPreparation = run.then(() => undefined, () => undefined);
  return run;
}

async function* blobChunks(blob: Blob): AsyncGenerator<Uint8Array> {
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function flushAttachments(
  persistence: IndexedDbSyncPersistence,
  transport: HttpSyncTransport,
  engine: BrowserSyncEngine,
): Promise<void> {
  for (const attachment of (await persistence.attachments()).sort((a, b) => a.clientSequence - b.clientSequence)) {
    if (attachment.size > 0) await transport.uploadBlob(attachment.blob, attachment.hash);
    const content = attachment.size === 0
      ? { hash: attachment.hash, size: 0, inlineText: '' }
      : { hash: attachment.hash, size: attachment.size, blobHash: attachment.hash };
    await engine.queue({
      operation: 'create', path: attachment.path, kind: 'file', content,
      clientSequence: attachment.clientSequence, idempotencyKey: attachment.idempotencyKey,
    });
    await persistence.removeAttachment(attachment.idempotencyKey);
  }
}

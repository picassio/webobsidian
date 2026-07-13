import { DEFAULT_LIMITS, normalizeVaultPath, sha256Chunks, sha256Text, type SyncOperation } from '@webobsidian/sync-core';
import { api } from './api';
import { BrowserLocalSyncAdapter } from './browser-sync-adapter';
import { IndexedDbSyncPersistence, type PendingAttachment } from './sync-db';
import { BrowserSyncEngine, HttpSyncTransport } from './sync-engine';
import { registerSyncSaveHandler, useStore, type DocumentState } from './store';

let activeEngine: BrowserSyncEngine | null = null;
let activeUpload: { persistence: IndexedDbSyncPersistence; transport: HttpSyncTransport; engine: BrowserSyncEngine } | null = null;

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
  activeUpload = { persistence, transport, engine };

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
  const path = normalizeVaultPath(`${dir.replace(/^\/+|\/+$/g, '')}/${safeName}`);
  const hash = await sha256Chunks(blobChunks(file));
  const attachment: PendingAttachment = {
    idempotencyKey: `web-upload-${crypto.randomUUID()}`,
    clientSequence: await activeUpload.persistence.takeClientSequence(),
    path, hash, size: file.size, blob: file, createdAt: new Date().toISOString(),
  };
  await activeUpload.persistence.putAttachment(attachment);
  await flushAttachments(activeUpload.persistence, activeUpload.transport, activeUpload.engine).catch(() => {});
  return { path, size: file.size };
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

import {
  ChangesResponseSchema,
  DEFAULT_LIMITS,
  HandshakeResponseSchema,
  ManifestPageSchema,
  OperationsResponseSchema,
  OrderedSyncClient,
  PROTOCOL_VERSION,
  type ClientDeviceIdentity,
  type SyncClientTransport,
  type SyncEntry,
  type SyncEvent,
  type SyncLocalAdapter,
} from '@webobsidian/sync-core';

export { OrderedSyncClient as BrowserSyncEngine };
export type { SyncConnectionStatus } from '@webobsidian/sync-core';
export type LocalSyncAdapter = SyncLocalAdapter;
export type SyncTransport = SyncClientTransport;

export class HttpSyncTransport implements SyncClientTransport {
  constructor(private readonly base = '/api/sync/v1') {}
  async handshake(device: ClientDeviceIdentity) {
    const value = await this.json('/handshake', { method: 'POST', body: JSON.stringify({
      protocolVersion: PROTOCOL_VERSION, deviceId: device.deviceId, deviceName: device.deviceName,
      lastAppliedSequence: device.cursor, capabilities: ['browser-indexeddb-v1'],
    }) });
    return HandshakeResponseSchema.parse(value);
  }
  async manifest() {
    const entries: SyncEntry[] = [];
    let cursor: string | null = null;
    let snapshotSequence = 0;
    do {
      const page = ManifestPageSchema.parse(await this.json(`/manifest${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`));
      entries.push(...page.entries);
      snapshotSequence = page.snapshotSequence;
      cursor = page.nextCursor;
    } while (cursor);
    return { entries, snapshotSequence };
  }
  async changes(after: number, limit: number) {
    return ChangesResponseSchema.parse(await this.json(`/changes?after=${after}&limit=${limit}`));
  }
  async acknowledge(sequence: number) {
    await this.json('/ack', { method: 'POST', body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, sequence }) });
  }
  async operations(operations: Parameters<SyncClientTransport['operations']>[0]) {
    const value = await this.json('/operations', { method: 'POST', body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, operations }) });
    return OperationsResponseSchema.parse(value).results;
  }
  async wsTicket() { return (await this.json('/ws-tickets', { method: 'POST', body: '{}' }) as { ticket: string }).ticket; }
  async connectWake(wake: () => void, closed: () => void): Promise<() => void> {
    const ticket = await this.wsTicket();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}${this.base}/ws?ticket=${encodeURIComponent(ticket)}`);
    socket.onmessage = (message) => {
      try { if ((JSON.parse(String(message.data)) as { type?: string }).type === 'sync.changed') wake(); } catch { /* ignore malformed wake-up */ }
    };
    socket.onclose = closed;
    socket.onerror = () => socket.close();
    return () => socket.close();
  }
  async uploadText(content: string, hash: string): Promise<void> {
    await this.uploadBlob(new Blob([content]), hash);
  }
  async uploadBlob(blob: Blob, hash: string): Promise<void> {
    if (blob.size === 0) return;
    const chunkSize = DEFAULT_LIMITS.blobChunkBytes;
    const created = await this.json('/blob-uploads', {
      method: 'POST', body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, hash, size: blob.size, chunkSize }),
    }) as { uploadId: string; missingParts: number[] };
    for (const part of created.missingParts) {
      const start = part * chunkSize;
      const response = await fetch(`${this.base}/blob-uploads/${encodeURIComponent(created.uploadId)}/${part}`, {
        method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/octet-stream' },
        body: blob.slice(start, Math.min(blob.size, start + chunkSize)),
      });
      if (!response.ok) throw new Error(`blob_part_upload_failed: ${response.status}`);
    }
    await this.json(`/blob-uploads/${encodeURIComponent(created.uploadId)}/complete`, { method: 'POST', body: '{}' });
  }
  async fileText(event: SyncEvent): Promise<string | null> {
    const response = await fetch(`${this.base}/files/${encodeURIComponent(event.entryId)}?revision=${event.revision}`, { credentials: 'include' });
    if (!response.ok) throw new Error(`file_download_failed: ${response.status}`);
    const type = response.headers.get('content-type') ?? '';
    if (!type.startsWith('text/') && !/\.(md|markdown|txt|json|css|js|ts|tsx|jsx|html|xml|yaml|yml|csv|svg)$/i.test(event.path)) return null;
    return response.text();
  }
  private async json(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.base}${path}`, {
      credentials: 'include', ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
      throw new Error(`${body.error?.code ?? response.status}: ${body.error?.message ?? response.statusText}`);
    }
    return response.json() as Promise<unknown>;
  }
}

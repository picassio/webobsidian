import { promises as fs } from 'node:fs';
import WebSocket from 'ws';
import {
  BlobUploadCreateResponseSchema,
  ChangesResponseSchema,
  ConflictsResponseSchema,
  DEFAULT_LIMITS,
  HandshakeResponseSchema,
  ManifestPageSchema,
  OperationsResponseSchema,
  PairResponseSchema,
  PROTOCOL_VERSION,
  sha256Chunks,
  WsTicketResponseSchema,
  type ClientDeviceIdentity,
  type Conflict,
  type SyncClientTransport,
  type SyncEntry,
  type SyncOperation,
} from '@webobsidian/sync-core';

export class TransportError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly retryable: boolean) { super(message); }
}
export class NodeSyncTransport implements SyncClientTransport {
  readonly baseUrl: string;
  constructor(serverUrl: string, private readonly token: string) { this.baseUrl = validateServerUrl(serverUrl); }
  static async pair(serverUrl: string, code: string, deviceId: string, deviceName: string) {
    const transport = new NodeSyncTransport(serverUrl, 'pairing');
    return PairResponseSchema.parse(await transport.json('/pair', {
      method: 'POST', body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, code, deviceId, deviceName }),
    }, false));
  }
  async handshake(device: ClientDeviceIdentity) {
    return HandshakeResponseSchema.parse(await this.json('/handshake', { method: 'POST', body: JSON.stringify({
      protocolVersion: PROTOCOL_VERSION, deviceId: device.deviceId, deviceName: device.deviceName,
      lastAppliedSequence: device.cursor, capabilities: ['headless-fs-v1', 'apply-intent-v1', 'resumable-blob-v1'],
    }) }));
  }
  async manifest() {
    const entries: SyncEntry[] = []; let cursor: string | null = null; let snapshotSequence = 0;
    do {
      const page = ManifestPageSchema.parse(await this.json(`/manifest${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`));
      entries.push(...page.entries); snapshotSequence = page.snapshotSequence; cursor = page.nextCursor;
    } while (cursor);
    return { entries, snapshotSequence };
  }
  async changes(after: number, limit: number) { return ChangesResponseSchema.parse(await this.json(`/changes?after=${after}&limit=${limit}`)); }
  async acknowledge(sequence: number) { await this.json('/ack', { method: 'POST', body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, sequence }) }); }
  async operations(operations: SyncOperation[]) {
    return OperationsResponseSchema.parse(await this.json('/operations', { method: 'POST', body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, operations }) })).results;
  }
  async connectWake(wake: () => void, closed: () => void): Promise<() => void> {
    const ticket = WsTicketResponseSchema.parse(await this.json('/ws-tickets', { method: 'POST', body: '{}' })).ticket;
    const url = new URL(this.baseUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/sync/v1/ws`; url.search = `ticket=${encodeURIComponent(ticket)}`;
    const socket = new WebSocket(url);
    socket.on('message', (data) => { try { if ((JSON.parse(data.toString()) as { type?: string }).type === 'sync.changed') wake(); } catch { /* no content in wake */ } });
    socket.on('close', closed); socket.on('error', () => socket.close());
    return () => socket.close();
  }
  async download(entryId: string, revision: number): Promise<Response> {
    return this.request(`/files/${encodeURIComponent(entryId)}?revision=${revision}`);
  }
  async uploadFile(file: string, hash: string, size: number): Promise<void> {
    if (size === 0) return;
    const chunkSize = DEFAULT_LIMITS.blobChunkBytes;
    const created = BlobUploadCreateResponseSchema.parse(await this.json('/blob-uploads', {
      method: 'POST', body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, hash, size, chunkSize }),
    }));
    const handle = await fs.open(file, 'r');
    try {
      for (const part of created.missingParts) {
        const start = part * chunkSize; const length = Math.min(chunkSize, size - start);
        const buffer = Buffer.allocUnsafe(length); const { bytesRead } = await handle.read(buffer, 0, length, start);
        if (bytesRead !== length) throw new Error(`short read while uploading ${file}`);
        await this.request(`/blob-uploads/${encodeURIComponent(created.uploadId)}/${part}`, {
          method: 'PUT', body: buffer, headers: { 'content-type': 'application/octet-stream' },
        });
      }
    } finally { await handle.close(); }
    await this.json(`/blob-uploads/${encodeURIComponent(created.uploadId)}/complete`, { method: 'POST', body: '{}' });
  }
  async conflicts(): Promise<Conflict[]> { return ConflictsResponseSchema.parse(await this.json('/conflicts')).conflicts; }
  async resolveConflict(
    conflictId: string,
    resolution: 'keep-server' | 'keep-client' | 'copy' | 'merged',
    sequence: number,
    key: string,
    mergedFile?: string,
  ) {
    let mergedContent: { hash: string; size: number; blobHash?: string; inlineText?: string } | undefined;
    if (resolution === 'merged') {
      if (!mergedFile) throw new Error('--merged-file is required for merged resolution');
      const stat = await fs.stat(mergedFile); const hash = await sha256Chunks((await import('node:fs')).createReadStream(mergedFile));
      if (stat.size <= DEFAULT_LIMITS.inlineTextBytes) {
        const text = await fs.readFile(mergedFile, 'utf8');
        if (Buffer.byteLength(text) !== stat.size) throw new Error('merged file must be UTF-8 text');
        mergedContent = { hash, size: stat.size, inlineText: text };
      } else { await this.uploadFile(mergedFile, hash, stat.size); mergedContent = { hash, size: stat.size, blobHash: hash }; }
    }
    return this.json(`/conflicts/${encodeURIComponent(conflictId)}/resolve`, {
      method: 'POST', body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION, clientSequence: sequence, idempotencyKey: key, resolution,
        ...(mergedContent ? { mergedContent } : {}),
      }),
    });
  }

  private async json(pathname: string, init: RequestInit = {}, authenticated = true): Promise<unknown> {
    const response = await this.request(pathname, init, authenticated);
    return response.json();
  }
  private async request(pathname: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
    const response = await fetch(`${this.baseUrl}/api/sync/v1${pathname}`, {
      ...init, headers: { ...(init.body && !(init.headers as Record<string, string> | undefined)?.['content-type'] ? { 'content-type': 'application/json' } : {}),
        ...(authenticated ? { authorization: `Bearer ${this.token}` } : {}), ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string; retryable?: boolean } };
      throw new TransportError(payload.error?.code ?? `http_${response.status}`, payload.error?.message ?? response.statusText, response.status, payload.error?.retryable ?? false);
    }
    return response;
  }
}

export function validateServerUrl(input: string): string {
  const url = new URL(input.trim()); const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) throw new Error('server URL must use HTTPS outside loopback');
  url.hash = ''; url.search = ''; return url.toString().replace(/\/$/, '');
}

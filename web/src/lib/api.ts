// Thin fetch wrapper around the WebObsidian server API.
import {
  sha256Text,
  type Conflict,
  type Device,
  type OperationResult,
} from '@picassio/sync-core';
import { vaultHeaders, withVaultQuery } from './vault-selection';

export interface SyncHealthResponse {
  protocolVersion: string;
  initialized: boolean;
  readOnly: boolean;
  reason: string | null;
  latestSequence: number;
  indexLagSequence: number;
  alerts: Array<{ severity: 'critical' | 'warning'; code: string; message: string }>;
  metrics: Record<string, unknown>;
}

export interface SyncDoctorIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
  repairable: boolean;
  repaired: boolean;
}

export interface SyncDoctorResponse {
  protocolVersion: string;
  healthy: boolean;
  readOnlyRecommended: boolean;
  latestSequence: number | null;
  checkedEntries: number;
  checkedBlobs: number;
  issues: SyncDoctorIssue[];
}

export interface SyncConflictResolutionResponse {
  protocolVersion: string;
  conflict: Conflict;
  result?: OperationResult;
}

export interface VaultSummary {
  id: string;
  name: string;
  path: string;
  storage: 'legacy' | 'isolated';
  isDefault: boolean;
  sync: { enabled: boolean; bootstrapState: 'backup-required' | 'ready' };
}

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  ext?: string;
  size?: number;
  mtime?: number;
  ctime?: number;
  children?: TreeNode[];
}

export interface TrashItem {
  name: string;
  path: string; // includes the .trash/ prefix
  original: string; // where it restores to
  ext: string;
  size: number;
  mtime: number;
}

export interface ShareRecord {
  id: string;
  path: string;
  enabled: boolean;
  createdAt: string;
  hasPassword?: boolean;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  tags: string[];
  snippet: string;
}

export interface MatchContext {
  text: string;
  ranges: [number, number][];
  pre: boolean;
  post: boolean;
}

export interface NoteMatches {
  path: string;
  count: number;
  contexts: MatchContext[];
}

export interface GitCommit {
  hash: string;
  date: string;
  message: string;
  author: string;
}

async function req<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const { headers: optHeaders, ...rest } = opts;
  const res = await fetch(url, {
    credentials: 'include',
    ...rest,
    // headers MUST be merged last — spreading ...opts after a `headers` literal
    // would drop Content-Type whenever a caller passes its own headers.
    headers: vaultHeaders({ 'Content-Type': 'application/json', ...(optHeaders ?? {}) }),
  });
  if (res.status === 401) {
    throw new ApiError('Unauthorized', 401);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const payload = await res.json() as { error?: string | { message?: string } };
      msg = typeof payload.error === 'string' ? payload.error : (payload.error?.message ?? msg);
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status);
  }
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? res.json() : (res.text() as unknown)) as Promise<T>;
}

async function syncDeviceFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const response = await fetch(`/api/sync/v1${path}`, { credentials: 'include', ...opts, headers: vaultHeaders(opts.headers) });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: { message?: string } | string };
    throw new ApiError(typeof payload.error === 'string' ? payload.error : (payload.error?.message ?? response.statusText), response.status);
  }
  return response;
}

async function syncDeviceReq<T>(path: string, opts: RequestInit = {}): Promise<T> {
  return req<T>(`/api/sync/v1${path}`, opts);
}

async function currentFileRevision(path: string): Promise<number> {
  const entry = await req<{ revision: number }>(`/api/files/revision?path=${encodeURIComponent(path)}`);
  return entry.revision;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export const api = {
  // auth
  authStatus: () => req<{ passwordSet: boolean; mustChangePassword: boolean }>('/auth/status'),
  setup: (password: string) =>
    req<{ ok: true }>('/auth/setup', { method: 'POST', body: JSON.stringify({ password }) }),
  login: (password: string) =>
    req<{ ok: true; mustChangePassword: boolean }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => req<{ ok: true }>('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: true }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  me: () => req<{ authenticated: boolean; mustChangePassword: boolean }>('/auth/me'),

  // vault registry
  listVaults: () => req<{ defaultVaultId: string; vaults: VaultSummary[] }>('/api/vaults/'),
  registerVault: (name: string, path: string) => req<{ vault: VaultSummary }>('/api/vaults/', {
    method: 'POST', body: JSON.stringify({ name, path }),
  }),
  renameVault: (vaultId: string, name: string) => req<{ ok: true }>(`/api/vaults/${encodeURIComponent(vaultId)}`, {
    method: 'PATCH', body: JSON.stringify({ name }),
  }),
  setDefaultVault: (vaultId: string) => req<{ ok: true }>(`/api/vaults/${encodeURIComponent(vaultId)}`, {
    method: 'PATCH', body: JSON.stringify({ default: true }),
  }),
  unregisterVault: (vaultId: string) => req<{ ok: true; filesDeleted: false }>(`/api/vaults/${encodeURIComponent(vaultId)}`, {
    method: 'DELETE', body: JSON.stringify({ confirm: vaultId }),
  }),

  // files
  tree: () => req<TreeNode>('/api/files/'),
  read: (path: string) =>
    req<{ path: string; content: string; entryId?: string; revision?: number; hash?: string | null }>(
      `/api/files/content?path=${encodeURIComponent(path)}`,
    ),
  write: (path: string, content: string, baseRevision?: number) =>
    req<{ ok: true; entryId: string; revision: number; hash: string | null; path: string }>(
      '/api/files/content',
      {
        method: 'PUT',
        body: JSON.stringify({ path, content, ...(baseRevision !== undefined ? { baseRevision } : {}) }),
      },
    ),
  createFolder: (path: string) =>
    req<{ ok: true }>('/api/files/folder', { method: 'POST', body: JSON.stringify({ path }) }),
  revision: (path: string) => req<{ entryId: string; path: string; kind: 'file' | 'directory'; revision: number; hash: string | null; size: number }>(`/api/files/revision?path=${encodeURIComponent(path)}`),
  rename: async (from: string, to: string) =>
    req<{ ok: true }>('/api/files/rename', { method: 'PATCH', body: JSON.stringify({ from, to, baseRevision: await currentFileRevision(from) }) }),
  copy: async (from: string, to: string) =>
    req<{ ok: true }>('/api/files/copy', { method: 'POST', body: JSON.stringify({ from, to, baseRevision: await currentFileRevision(from) }) }),
  remove: async (path: string) =>
    req<{ ok: true; trashed?: string; deleted?: string }>(
      `/api/files/?path=${encodeURIComponent(path)}`,
      { method: 'DELETE', body: JSON.stringify({ baseRevision: await currentFileRevision(path) }) },
    ),
  // trash (FR-1)
  listTrash: () => req<{ items: TrashItem[] }>('/api/files/trash'),
  restoreTrash: (path: string) =>
    req<{ ok: true; restored: string }>('/api/files/trash/restore', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  deleteTrashItem: (path: string) =>
    req<{ ok: true }>(`/api/files/trash/item?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  emptyTrash: () => req<{ ok: true }>('/api/files/trash', { method: 'DELETE' }),
  uploadUrl: () => '/api/files/upload',
  upload: async (file: File, dir = 'attachments') => {
    const fd = new FormData();
    fd.append('dir', dir);
    const target = `${dir.replace(/^\/+|\/+$/g, '')}/${file.name}`;
    const existingRevision = await currentFileRevision(target).catch((error) => error instanceof ApiError && error.status === 404 ? null : Promise.reject(error));
    if (existingRevision !== null) fd.append('baseRevision', String(existingRevision));
    fd.append('file', file);
    const res = await fetch('/api/files/upload', { method: 'POST', credentials: 'include', headers: vaultHeaders(), body: fd });
    if (!res.ok) throw new ApiError((await res.json().catch(() => ({}))).error ?? 'Upload failed', res.status);
    return res.json() as Promise<{ ok: true; path: string; size: number }>;
  },
  rawUrl: (path: string) => withVaultQuery(`/api/files/content?path=${encodeURIComponent(path)}`),

  // search & links
  // limit omitted → server returns every match (panel renders them incrementally)
  search: (q: string, limit?: number) =>
    req<{ hits: SearchHit[] }>(
      `/api/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`,
    ),
  // per-note highlighted match contexts for the given paths (lazy, batched);
  // phrase=true matches the whole query as one needle (unlinked mentions)
  searchMatches: (query: string, paths: string[], matchCase = false, phrase = false) =>
    req<{ matches: NoteMatches[] }>('/api/search/matches', {
      method: 'POST',
      body: JSON.stringify({ query, paths, matchCase, phrase }),
    }),
  tags: () => req<{ tags: { tag: string; count: number }[] }>('/api/tags'),
  properties: () =>
    req<{ properties: { key: string; type: string; count: number }[] }>('/api/properties'),
  propertyTypes: () => req<{ types: Record<string, string> }>('/api/property-types'),
  setPropertyType: (key: string, type: string) =>
    req<{ types: Record<string, string> }>('/api/property-types', {
      method: 'POST',
      body: JSON.stringify({ key, type }),
    }),
  backlinks: (path: string) =>
    req<{ backlinks: string[] }>(`/api/backlinks?path=${encodeURIComponent(path)}`),
  resolve: (target: string) =>
    req<{ path: string | null }>(`/api/resolve?target=${encodeURIComponent(target)}`),
  graph: () =>
    req<{
      nodes: { id: string; label: string; kind: 'note' | 'attachment' | 'unresolved'; tags: string[] }[];
      edges: { source: string; target: string }[];
    }>('/api/graph'),
  reindex: () => req<{ ok: true }>('/api/reindex', { method: 'POST' }),

  // Central Sync administration and browser pairing
  createSyncPairingCode: (deviceNameHint: string) =>
    req<{ protocolVersion: string; code: string; expiresAt: string }>('/api/sync/v1/pairing-codes', {
      method: 'POST', body: JSON.stringify({ deviceNameHint }),
    }),
  createBrowserSyncDevice: (deviceId: string, deviceName: string) =>
    req<{ protocolVersion: string; vaultId: string; deviceId: string }>('/api/sync/v1/browser-devices', {
      method: 'POST', body: JSON.stringify({ deviceId, deviceName }),
    }),
  upgradeBrowserSyncDevice: (token: string) => req<{ protocolVersion: string; deviceId: string }>('/api/sync/v1/browser-device/upgrade', {
    method: 'POST', body: JSON.stringify({ token }),
  }),
  clearBrowserSyncDevice: () => req<void>('/api/sync/v1/browser-device/logout', { method: 'POST', body: '{}' }),
  pairSyncDevice: (code: string, deviceId: string, deviceName: string) =>
    req<{ protocolVersion: string; vaultId: string; deviceId: string; token: string }>('/api/sync/v1/pair', {
      method: 'POST', body: JSON.stringify({ protocolVersion: '1.0', code, deviceId, deviceName }),
    }),
  syncHealth: () => req<SyncHealthResponse>('/api/sync/v1/health'),
  syncDoctor: () => req<SyncDoctorResponse>('/api/sync/v1/doctor'),
  syncDevices: () => req<{ protocolVersion: string; devices: Device[] }>('/api/sync/v1/devices'),
  revokeSyncDevice: (deviceId: string) => req<{ ok: true }>(`/api/sync/v1/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' }),
  syncConflicts: () => syncDeviceReq<{ protocolVersion: string; conflicts: Conflict[] }>('/conflicts'),
  syncRevisionText: async (entryId: string, revision: number) =>
    (await syncDeviceFetch(`/files/${encodeURIComponent(entryId)}?revision=${revision}`)).text(),
  downloadSyncBlob: async (hash: string, filename: string) => {
    const blob = await (await syncDeviceFetch(`/blobs/${encodeURIComponent(hash)}`)).blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  },
  resolveSyncConflict: (conflictId: string, resolution: 'keep-server' | 'keep-client' | 'merged' | 'copy', clientSequence: number, mergedContent?: string) =>
    syncDeviceReq<SyncConflictResolutionResponse>(`/conflicts/${encodeURIComponent(conflictId)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        protocolVersion: '1.0', clientSequence, resolution,
        idempotencyKey: `web-resolve-${crypto.randomUUID()}`,
        ...(mergedContent !== undefined ? { mergedContent: {
          hash: sha256Text(mergedContent),
          size: new TextEncoder().encode(mergedContent).byteLength,
          inlineText: mergedContent,
        } } : {}),
      }),
    }),

  // Legacy one-time source for migrating shared workspace state into per-device IndexedDB.
  getUiState: () => req<any>('/api/uistate/'),
  putUiState: (state: any, clientId: string) =>
    req<{ ok: true }>('/api/uistate/', {
      method: 'PUT',
      headers: { 'X-Client-Id': clientId },
      body: JSON.stringify(state),
    }),

  // settings
  getSettings: () => req<any>('/api/settings/'),
  putSettings: (patch: any) => req<any>('/api/settings/', { method: 'PUT', body: JSON.stringify(patch) }),
  browse: (dir?: string) =>
    req<{ dir: string; parent: string; roots: string[]; folders: { name: string; path: string }[] }>(
      `/api/settings/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`,
    ),

  // git
  gitStatus: () => req<any>('/api/git/status'),
  gitInit: () => req<any>('/api/git/init', { method: 'POST' }),
  gitClone: () => req<any>('/api/git/clone', { method: 'POST' }),
  gitPull: () => req<{ message: string }>('/api/git/pull', { method: 'POST' }),
  gitCommit: (message?: string) =>
    req<{ message: string }>('/api/git/commit', { method: 'POST', body: JSON.stringify({ message }) }),
  gitPush: () => req<{ message: string }>('/api/git/push', { method: 'POST' }),
  gitSync: (message?: string) =>
    req<{ ok: boolean; log: string[] }>('/api/git/sync', { method: 'POST', body: JSON.stringify({ message }) }),
  gitMigration: () => req<any>('/api/git/migration'),
  migrateGitToBackup: (confirm: boolean, allowLocalOnlyBackup = false) =>
    req<any>('/api/git/migration', { method: 'POST', body: JSON.stringify({ confirm, allowLocalOnlyBackup }) }),
  gitImport: (confirm: boolean, deleteMissing = false) =>
    req<any>('/api/git/import', { method: 'POST', body: JSON.stringify({ confirm, deleteMissing }) }),
  gitLog: (path: string) =>
    req<{ commits: GitCommit[] }>(`/api/git/log?path=${encodeURIComponent(path)}`),
  gitShow: (hash: string, path: string) =>
    req<{ content: string }>(`/api/git/show?hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(path)}`),

  // api keys
  listKeys: () => req<{ keys: any[] }>('/api/keys/'),
  createKey: (name: string, scopes: string[]) =>
    req<{ key: string; record: any }>('/api/keys/', { method: 'POST', body: JSON.stringify({ name, scopes }) }),
  revokeKey: (id: string) => req<{ ok: boolean }>(`/api/keys/${id}`, { method: 'DELETE' }),

  // public shares (FR-10)
  listShares: () => req<{ shares: ShareRecord[] }>('/api/shares/'),
  createShare: (path: string) =>
    req<{ share: ShareRecord }>('/api/shares/', { method: 'POST', body: JSON.stringify({ path }) }),
  setShareEnabled: (id: string, enabled: boolean) =>
    req<{ share: ShareRecord }>(`/api/shares/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteShare: (id: string) => req<{ ok: true }>(`/api/shares/${id}`, { method: 'DELETE' }),
  // password = null clears the share's password
  setSharePassword: (id: string, password: string | null) =>
    req<{ share: ShareRecord }>(`/api/shares/${id}`, { method: 'PATCH', body: JSON.stringify({ password }) }),
  // NOTE: the public-facing /share/<id> page is fully server-rendered (SSR) —
  // the SPA never fetches /public/shares/* itself.

  // plugins
  listPlugins: () => req<{ plugins: any[] }>('/api/plugins/'),
  installPlugin: (repo: string) =>
    req<{ plugin: any }>('/api/plugins/install', { method: 'POST', body: JSON.stringify({ repo }) }),
  setPluginEnabled: (id: string, enabled: boolean) =>
    req<{ ok: true }>(`/api/plugins/${id}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
};

import { BlobStore } from '../sync/blob-store.js';
import { SyncCoordinator } from '../sync/coordinator.js';
import { DeviceStore } from '../sync/device-store.js';
import { UploadStore } from '../sync/upload-store.js';
import { SyncRetentionManager, type CompactionResult } from '../sync/retention.js';
import { VaultStateStore } from '../sync/vault-state.js';
import { redactUrlCreds } from '../lib/redact.js';
import { currentVaultId, runInVault, type VaultContext } from './vault-context.js';
import { vaultDataDir } from './vault-registry.js';
import type { VaultRecord } from './settings.js';

interface MaintenanceState {
  running: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastCompaction: CompactionResult | null;
  nextRunAt: string | null;
}

export interface SyncRuntime {
  context: VaultContext;
  coordinator: SyncCoordinator;
  blobs: BlobStore;
  devices: DeviceStore;
  uploads: UploadStore;
  retention: SyncRetentionManager;
  maintenanceTimer: NodeJS.Timeout | null;
  maintenance: MaintenanceState;
  draining: boolean;
  activeRequests: number;
  drainWaiters: Set<() => void>;
}

const runtimes = new Map<string, SyncRuntime>();
let defaultRuntimeId: string | null = null;

function blankMaintenance(): MaintenanceState {
  return { running: false, lastRunAt: null, lastSuccessAt: null, lastError: null, lastCompaction: null, nextRunAt: null };
}

async function createRuntime(context: VaultContext): Promise<SyncRuntime> {
  const existing = runtimes.get(context.vaultId);
  if (existing) return existing;
  const state = await new VaultStateStore(context.dataDir, context.vaultId).loadOrCreate();
  if (state.vaultId !== context.vaultId) throw new Error(`Vault registry identity does not match sync metadata for ${context.vaultId}`);
  const blobs = new BlobStore(context.dataDir);
  const devices = new DeviceStore(context.dataDir);
  const uploads = new UploadStore(context.dataDir);
  const retention = new SyncRetentionManager(context.dataDir);
  const coordinator = new SyncCoordinator({
    vaultRoot: context.root,
    dataDir: context.dataDir,
    resolveBlob: async (hash) => {
      const blob = await blobs.get(hash);
      if (!blob) throw new Error(`blob ${hash} not found`);
      return blob.file;
    },
  });
  await runInVault(context, () => coordinator.initialize());
  const runtime: SyncRuntime = {
    context, coordinator, blobs, devices, uploads, retention,
    maintenanceTimer: null,
    maintenance: blankMaintenance(),
    draining: false,
    activeRequests: 0,
    drainWaiters: new Set(),
  };
  runtimes.set(context.vaultId, runtime);
  scheduleMaintenance(runtime, 5 * 60_000);
  return runtime;
}

/** Compatibility initializer used by focused tests and one-vault embeddings. */
export async function initializeSyncRuntime(vaultRoot: string, dataDir: string): Promise<SyncCoordinator> {
  const state = await new VaultStateStore(dataDir).loadOrCreate();
  const context: VaultContext = { vaultId: state.vaultId, root: vaultRoot, dataDir, isDefault: true };
  defaultRuntimeId ??= state.vaultId;
  return (await createRuntime(context)).coordinator;
}

export async function initializeSyncRuntimes(records: VaultRecord[], defaultVaultId: string): Promise<SyncRuntime[]> {
  defaultRuntimeId = defaultVaultId;
  const initialized: SyncRuntime[] = [];
  // Startup is intentionally sequential: each coordinator can hash a large
  // existing vault and unbounded parallel bootstrap would spike disk/RAM.
  for (const record of records) {
    initialized.push(await createRuntime({
      vaultId: record.id,
      root: record.path,
      dataDir: vaultDataDir(record.id, record.storage),
      isDefault: record.id === defaultVaultId,
    }));
  }
  return initialized;
}

export async function addSyncRuntime(record: VaultRecord, defaultVaultId: string): Promise<SyncRuntime> {
  return createRuntime({
    vaultId: record.id,
    root: record.path,
    dataDir: vaultDataDir(record.id, record.storage),
    isDefault: record.id === defaultVaultId,
  });
}

export function beginSyncRuntimeDrain(vaultId: string): void {
  const runtime = runtimes.get(vaultId);
  if (runtime) runtime.draining = true;
}

export function cancelSyncRuntimeDrain(vaultId: string): void {
  const runtime = runtimes.get(vaultId);
  if (runtime) runtime.draining = false;
}

export function leaseSyncRuntime(runtime: SyncRuntime): (() => void) | null {
  if (runtime.draining) return null;
  runtime.activeRequests += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    runtime.activeRequests = Math.max(0, runtime.activeRequests - 1);
    if (runtime.activeRequests === 0) {
      for (const resolve of runtime.drainWaiters) resolve();
      runtime.drainWaiters.clear();
    }
  };
}

export async function waitForSyncRuntimeDrain(vaultId: string, timeoutMs = 30_000): Promise<void> {
  const runtime = runtimes.get(vaultId);
  if (!runtime || runtime.activeRequests === 0) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      runtime.drainWaiters.delete(done);
      reject(Object.assign(new Error('Timed out waiting for active vault requests to finish'), { status: 409 }));
    }, timeoutMs);
    runtime.drainWaiters.add(done);
  });
}

export async function removeSyncRuntime(vaultId: string): Promise<void> {
  const runtime = runtimes.get(vaultId);
  if (!runtime) return;
  if (runtime.activeRequests > 0) throw new Error('Cannot remove a sync runtime with active requests');
  if (runtime.maintenanceTimer) clearTimeout(runtime.maintenanceTimer);
  await runtime.coordinator.flushProjection();
  runtimes.delete(vaultId);
}

export function listSyncRuntimes(): SyncRuntime[] {
  return [...runtimes.values()];
}

export function getSyncRuntime(vaultId = currentVaultId()): SyncRuntime {
  const id = vaultId ?? defaultRuntimeId;
  const runtime = id ? runtimes.get(id) : undefined;
  if (!runtime || runtime.draining) throw Object.assign(new Error('sync runtime is unavailable for the selected vault'), { status: 503 });
  return runtime;
}

export function getSyncCoordinator(): SyncCoordinator { return getSyncRuntime().coordinator; }
export function getSyncUploadStore(): UploadStore { return getSyncRuntime().uploads; }
export function getSyncDeviceStore(): DeviceStore { return getSyncRuntime().devices; }
export function getSyncBlobStore(): BlobStore { return getSyncRuntime().blobs; }

export async function authenticateSyncToken(token: string) {
  for (const runtime of runtimes.values()) {
    if (runtime.draining) continue;
    const authenticated = await runtime.devices.authenticateDetailed(token);
    if (authenticated.device) return { ...authenticated, runtime };
    if (authenticated.reason === 'revoked') return { ...authenticated, runtime };
  }
  return { device: null, reason: 'invalid' as const, runtime: null };
}

export async function pairSyncDeviceAcrossVaults(code: string, deviceId: string, deviceName: string) {
  let lastError: unknown;
  for (const runtime of runtimes.values()) {
    const release = leaseSyncRuntime(runtime);
    if (!release) continue;
    try {
      const paired = await runtime.devices.pair(code, deviceId, deviceName);
      return { paired, runtime };
    } catch (error) {
      lastError = error;
    } finally {
      release();
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Invalid or expired pairing code');
}

export async function rotateSyncTokenAcrossVaults(token: string) {
  for (const runtime of runtimes.values()) {
    const release = leaseSyncRuntime(runtime);
    if (!release) continue;
    try {
      const authenticated = await runtime.devices.authenticateDetailed(token);
      if (!authenticated.device) continue;
      return { rotated: await runtime.devices.rotateToken(token), runtime };
    } finally {
      release();
    }
  }
  throw new Error('Legacy browser credential is invalid or revoked');
}

export function getSyncMaintenanceStatus() {
  const runtime = getSyncRuntime();
  const result = runtime.maintenance.lastCompaction;
  return {
    ...runtime.maintenance,
    lastCompaction: result ? {
      throughSequence: result.throughSequence,
      removedSegments: result.removedSegments.length,
      removedTombstones: result.removedTombstones,
      removedBases: result.removedBases,
      removedBlobs: result.removedBlobs,
      backupCreated: result.backupDirectory !== null,
    } : null,
  };
}

export async function runSyncMaintenance(vaultId = currentVaultId()): Promise<void> {
  const runtime = getSyncRuntime(vaultId);
  const maintenance = runtime.maintenance;
  if (maintenance.running) return;
  maintenance.running = true;
  maintenance.lastRunAt = new Date().toISOString();
  try {
    await runInVault(runtime.context, async () => {
      const now = new Date();
      const minimumAcknowledgedSequence = await runtime.devices.minimumActiveAcknowledgement(new Date(now.getTime() - 90 * 24 * 60 * 60_000));
      const protectedBlobHashes = await runtime.coordinator.protectedConflictBlobHashes();
      maintenance.lastCompaction = await runtime.retention.compact({
        now, retentionMs: 30 * 24 * 60 * 60_000, minimumAcknowledgedSequence,
        maxBasesPerEntry: 20, protectedBlobHashes,
      });
      await runtime.uploads.cleanupExpired(now);
    });
    maintenance.lastSuccessAt = new Date().toISOString();
    maintenance.lastError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    maintenance.lastError = redactUrlCreds(message).replace(/(?:[A-Za-z]:)?[\\/][^\s]*/g, '<redacted-path>');
  } finally {
    maintenance.running = false;
    scheduleMaintenance(runtime, 24 * 60 * 60_000);
  }
}

function scheduleMaintenance(runtime: SyncRuntime, delayMs: number): void {
  if (runtime.maintenanceTimer) clearTimeout(runtime.maintenanceTimer);
  runtime.maintenance.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  runtime.maintenanceTimer = setTimeout(() => void runSyncMaintenance(runtime.context.vaultId), delayMs);
  runtime.maintenanceTimer.unref();
}

export async function shutdownSyncRuntime(): Promise<void> {
  await Promise.all([...runtimes.values()].map(async (runtime) => {
    if (runtime.maintenanceTimer) clearTimeout(runtime.maintenanceTimer);
    runtime.maintenanceTimer = null;
    runtime.maintenance.nextRunAt = null;
    await runtime.coordinator.flushProjection();
  }));
}

import { BlobStore } from '../sync/blob-store.js';
import { SyncCoordinator } from '../sync/coordinator.js';
import { DeviceStore } from '../sync/device-store.js';
import { UploadStore } from '../sync/upload-store.js';
import { SyncRetentionManager, type CompactionResult } from '../sync/retention.js';
import { redactUrlCreds } from '../lib/redact.js';

let coordinator: SyncCoordinator | null = null;
let blobs: BlobStore | null = null;
let devices: DeviceStore | null = null;
let uploads: UploadStore | null = null;
let retention: SyncRetentionManager | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
const maintenance = {
  running: false,
  lastRunAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastError: null as string | null,
  lastCompaction: null as CompactionResult | null,
  nextRunAt: null as string | null,
};

export async function initializeSyncRuntime(vaultRoot: string, dataDir: string): Promise<SyncCoordinator> {
  if (coordinator) return coordinator;
  blobs = new BlobStore(dataDir);
  devices = new DeviceStore(dataDir);
  uploads = new UploadStore(dataDir);
  retention = new SyncRetentionManager(dataDir);
  coordinator = new SyncCoordinator({
    vaultRoot,
    dataDir,
    resolveBlob: async (hash) => {
      const blob = await blobs!.get(hash);
      if (!blob) throw new Error(`blob ${hash} not found`);
      return blob.file;
    },
  });
  await coordinator.initialize();
  scheduleMaintenance(5 * 60_000);
  return coordinator;
}

export function getSyncCoordinator(): SyncCoordinator {
  if (!coordinator) throw new Error('sync runtime is not initialized');
  return coordinator;
}

export function getSyncUploadStore(): UploadStore {
  if (!uploads) throw new Error('sync runtime is not initialized');
  return uploads;
}

export function getSyncDeviceStore(): DeviceStore {
  if (!devices) throw new Error('sync runtime is not initialized');
  return devices;
}

export function getSyncMaintenanceStatus() {
  const result = maintenance.lastCompaction;
  return {
    ...maintenance,
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

export async function runSyncMaintenance(): Promise<void> {
  if (maintenance.running || !coordinator || !devices || !uploads || !retention) return;
  maintenance.running = true;
  maintenance.lastRunAt = new Date().toISOString();
  try {
    const now = new Date();
    const minimumAcknowledgedSequence = await devices.minimumActiveAcknowledgement(new Date(now.getTime() - 90 * 24 * 60 * 60_000));
    const protectedBlobHashes = await coordinator.protectedConflictBlobHashes();
    maintenance.lastCompaction = await retention.compact({
      now, retentionMs: 30 * 24 * 60 * 60_000, minimumAcknowledgedSequence,
      maxBasesPerEntry: 20, protectedBlobHashes,
    });
    await uploads.cleanupExpired(now);
    maintenance.lastSuccessAt = new Date().toISOString();
    maintenance.lastError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    maintenance.lastError = redactUrlCreds(message).replace(/(?:[A-Za-z]:)?[\\/][^\s]*/g, '<redacted-path>');
  } finally {
    maintenance.running = false;
    scheduleMaintenance(24 * 60 * 60_000);
  }
}

function scheduleMaintenance(delayMs: number): void {
  if (maintenanceTimer) clearTimeout(maintenanceTimer);
  maintenance.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  maintenanceTimer = setTimeout(() => void runSyncMaintenance(), delayMs);
  maintenanceTimer.unref();
}

export async function shutdownSyncRuntime(): Promise<void> {
  if (maintenanceTimer) clearTimeout(maintenanceTimer);
  maintenanceTimer = null;
  maintenance.nextRunAt = null;
  if (coordinator) await coordinator.flushProjection();
}

export function getSyncBlobStore(): BlobStore {
  if (!blobs) throw new Error('sync runtime is not initialized');
  return blobs;
}

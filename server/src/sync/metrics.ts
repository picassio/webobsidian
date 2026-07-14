import { currentVaultId } from '../services/vault-context.js';

class SyncTransferMetrics {
  private uploadedBytes = 0;
  private deduplicatedBytes = 0;
  private completedUploads = 0;

  recordUpload(size: number, deduplicated: boolean): void {
    this.completedUploads += 1;
    if (deduplicated) this.deduplicatedBytes += size;
    else this.uploadedBytes += size;
  }

  snapshot(): { completedUploads: number; uploadedBytes: number; deduplicatedBytes: number; deduplicationRatio: number } {
    const total = this.uploadedBytes + this.deduplicatedBytes;
    return {
      completedUploads: this.completedUploads,
      uploadedBytes: this.uploadedBytes,
      deduplicatedBytes: this.deduplicatedBytes,
      deduplicationRatio: total ? this.deduplicatedBytes / total : 0,
    };
  }
}

const metrics = new Map<string, SyncTransferMetrics>();
function currentMetrics(): SyncTransferMetrics {
  const key = currentVaultId() ?? '__default__';
  let value = metrics.get(key);
  if (!value) { value = new SyncTransferMetrics(); metrics.set(key, value); }
  return value;
}

export const syncTransferMetrics = new Proxy({} as SyncTransferMetrics, {
  get(_target, property) {
    const value = Reflect.get(currentMetrics(), property);
    return typeof value === 'function' ? value.bind(currentMetrics()) : value;
  },
});

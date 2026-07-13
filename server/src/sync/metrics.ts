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

export const syncTransferMetrics = new SyncTransferMetrics();

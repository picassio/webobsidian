import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AtomicJsonStore, ensureSyncStorage } from './storage.js';

export const SYNC_SCHEMA_VERSION = 1;

export const VaultStateSchema = z.object({
  schemaVersion: z.literal(SYNC_SCHEMA_VERSION),
  vaultId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
  currentSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type VaultState = z.infer<typeof VaultStateSchema>;

export class VaultStateStore {
  private state: VaultState | null = null;
  private store: AtomicJsonStore<VaultState> | null = null;

  constructor(private readonly dataDir: string, private readonly preferredVaultId?: string) {}

  async loadOrCreate(): Promise<VaultState> {
    if (this.state) return this.state;
    const paths = await ensureSyncStorage(this.dataDir);
    this.store = new AtomicJsonStore(path.join(paths.root, 'vault.json'), VaultStateSchema);
    const existing = await this.store.read();
    if (existing) {
      this.state = existing;
      return existing;
    }
    const now = new Date().toISOString();
    const created: VaultState = {
      schemaVersion: SYNC_SCHEMA_VERSION,
      vaultId: this.preferredVaultId ?? `vault_${randomBytes(18).toString('base64url')}`,
      currentSequence: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.write(created);
    this.state = created;
    return created;
  }

  async setCurrentSequence(sequence: number): Promise<VaultState> {
    const current = await this.loadOrCreate();
    if (!Number.isSafeInteger(sequence) || sequence < current.currentSequence) {
      throw new Error(`sequence cannot move backwards (${current.currentSequence} → ${sequence})`);
    }
    if (sequence === current.currentSequence) return current;
    const next = { ...current, currentSequence: sequence, updatedAt: new Date().toISOString() };
    await this.store!.write(next);
    this.state = next;
    return next;
  }
}

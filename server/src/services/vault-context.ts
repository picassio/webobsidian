import { AsyncLocalStorage } from 'node:async_hooks';

export interface VaultContext {
  vaultId: string;
  root: string;
  dataDir: string;
  isDefault: boolean;
}

const storage = new AsyncLocalStorage<VaultContext>();

export function runInVault<T>(context: VaultContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function enterVault(context: VaultContext): void {
  storage.enterWith(context);
}

export function currentVaultContext(): VaultContext | undefined {
  return storage.getStore();
}

export function currentVaultId(): string | undefined {
  return storage.getStore()?.vaultId;
}

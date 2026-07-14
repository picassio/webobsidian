import { currentVaultId } from './vault-context.js';

/** Shared broadcaster; messages are isolated to the selected vault. */
type Broadcaster = (msg: unknown, vaultId?: string) => void;

let broadcaster: Broadcaster = () => {};

export function setBroadcaster(fn: Broadcaster): void {
  broadcaster = fn;
}

export function broadcast(msg: unknown): void {
  broadcaster(msg, currentVaultId());
}

import { getSettings } from './settings.js';
import { sync } from './git.js';
import { redactUrlCreds } from '../lib/redact.js';
import { currentVaultContext, runInVault, type VaultContext } from './vault-context.js';

interface AutoSyncState {
  timer: NodeJS.Timeout;
  running: boolean;
  failureCount: number;
  retryAfter: number;
  lastRun: number | null;
  context: VaultContext;
}

const states = new Map<string, AutoSyncState>();

/** Start one independent periodic Git backup loop for the selected vault. */
export function startAutoSync(context = currentVaultContext()): void {
  if (!context || states.has(context.vaultId)) return;
  const state: AutoSyncState = {
    timer: setInterval(() => void runInVault(context, () => tick(state)), 30_000),
    running: false,
    failureCount: 0,
    retryAfter: 0,
    lastRun: null,
    context,
  };
  state.timer.unref();
  states.set(context.vaultId, state);
}

export function stopAutoSync(vaultId: string): void {
  const state = states.get(vaultId);
  if (!state) return;
  clearInterval(state.timer);
  states.delete(vaultId);
}

async function tick(state: AutoSyncState): Promise<void> {
  if (state.running) return;
  const settings = await getSettings();
  if (!settings.git.enabled || !settings.git.autoSync || !settings.git.remote) return;
  if (Date.now() < state.retryAfter) return;
  const intervalMs = Math.max(settings.git.intervalSec, 60) * 1000;
  if (Date.now() - (state.lastRun ?? 0) < intervalMs) return;
  state.running = true;
  try {
    const result = await sync();
    state.lastRun = Date.now();
    if (result.ok) {
      state.failureCount = 0;
      state.retryAfter = 0;
      console.log(`[git-backup] vault=${state.context.vaultId} ${settings.sync.enabled ? 'backup' : 'legacy sync'} ok:`, result.log.join(' | '));
    } else {
      state.failureCount += 1;
      state.retryAfter = Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(state.failureCount, 7));
      console.warn(`[git-backup] vault=${state.context.vaultId} not-ok; retry scheduled:`, result.log.join(' | '));
    }
  } catch (error) {
    state.failureCount += 1;
    state.retryAfter = Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(state.failureCount, 7));
    console.warn(`[git-backup] vault=${state.context.vaultId} failed; retry scheduled:`, redactUrlCreds(error instanceof Error ? error.message : String(error)));
  } finally {
    state.running = false;
  }
}

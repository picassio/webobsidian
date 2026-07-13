import { getSettings } from './settings.js';
import { sync } from './git.js';
import { redactUrlCreds } from '../lib/redact.js';

/** Periodic auto-sync when enabled in settings (PRD FR-4). */
let timer: NodeJS.Timeout | null = null;
let running = false;
let failureCount = 0;
let retryAfter = 0;

export function startAutoSync(): void {
  if (timer) clearInterval(timer);
  // Re-evaluate settings each tick so toggling takes effect without restart.
  timer = setInterval(tick, 30_000);
}

async function tick(): Promise<void> {
  if (running) return;
  const s = await getSettings();
  if (!s.git.enabled || !s.git.autoSync || !s.git.remote) return;
  if (Date.now() < retryAfter) return;
  const intervalMs = Math.max(s.git.intervalSec, 60) * 1000;
  const last = lastRun ?? 0;
  if (Date.now() - last < intervalMs) return;
  running = true;
  try {
    const res = await sync();
    lastRun = Date.now();
    if (res.ok) {
      failureCount = 0; retryAfter = 0;
      console.log(`[git-backup] ${s.sync.enabled ? 'backup' : 'legacy sync'} ok:`, res.log.join(' | '));
    } else {
      failureCount += 1;
      retryAfter = Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(failureCount, 7));
      console.warn('[git-backup] not-ok; retry scheduled:', res.log.join(' | '));
    }
  } catch (e: any) {
    failureCount += 1;
    retryAfter = Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(failureCount, 7));
    console.warn('[git-backup] failed; retry scheduled:', redactUrlCreds(e.message));
  } finally {
    running = false;
  }
}

let lastRun: number | null = null;

import type { NextFunction, Request, Response } from 'express';
import { syncError } from './sync-auth.js';

const windows = new Map<string, number[]>();

export function syncRateLimit(
  bucket: string,
  limit: number,
  key: (request: Request) => string,
  windowMs = 60_000,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const mapKey = `${bucket}:${key(req)}`;
    const active = (windows.get(mapKey) ?? []).filter((timestamp) => timestamp > now - windowMs);
    if (active.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((active[0]! + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      syncError(res, 429, 'rate_limited', 'Rate limit exceeded', true, { retryAfter });
      return;
    }
    active.push(now);
    windows.set(mapKey, active);
    if (windows.size > 10_000) {
      for (const [candidate, timestamps] of windows) {
        if (!timestamps.some((timestamp) => timestamp > now - windowMs)) windows.delete(candidate);
        if (windows.size <= 8_000) break;
      }
    }
    next();
  };
}

export function requireSyncAdminCsrf(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).origin !== `${req.protocol}://${req.get('host')}`) {
        syncError(res, 403, 'scope_denied', 'Cross-origin admin mutation rejected', false);
        return;
      }
    } catch {
      syncError(res, 403, 'scope_denied', 'Invalid Origin header', false);
      return;
    }
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    syncError(res, 403, 'scope_denied', 'Cross-site admin mutation rejected', false);
    return;
  }
  next();
}

export const SYNC_RATE_LIMITS = Object.freeze({
  ipPerMinute: 1_800,
  pairingPerMinute: 10,
  deviceControlPerMinute: 120,
  deviceTransferPerMinute: 600,
  uploadPerMinute: 600,
});

export const preAuthSyncRateLimit = syncRateLimit('sync-ip', SYNC_RATE_LIMITS.ipPerMinute, (req) => req.ip ?? 'unknown');
export const pairingRateLimit = syncRateLimit('pairing', SYNC_RATE_LIMITS.pairingPerMinute, (req) => req.ip ?? 'unknown');
const deviceKey = (req: Request) => req.syncDevice ? `${req.syncVaultId ?? 'unknown'}:${req.syncDevice.deviceId}` : (req.ip ?? 'unknown');
// Keep Test/handshake diagnostics available while a first sync consumes its independent transfer budget.
export const deviceControlRateLimit = syncRateLimit('device-control', SYNC_RATE_LIMITS.deviceControlPerMinute, deviceKey);
export const deviceRateLimit = syncRateLimit('device-transfer', SYNC_RATE_LIMITS.deviceTransferPerMinute, deviceKey);
export const uploadRateLimit = syncRateLimit('upload', SYNC_RATE_LIMITS.uploadPerMinute, deviceKey);

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

export const preAuthSyncRateLimit = syncRateLimit('sync-ip', 300, (req) => req.ip ?? 'unknown');
export const pairingRateLimit = syncRateLimit('pairing', 10, (req) => req.ip ?? 'unknown');
const deviceKey = (req: Request) => req.syncDevice ? `${req.syncVaultId ?? 'unknown'}:${req.syncDevice.deviceId}` : (req.ip ?? 'unknown');
export const deviceRateLimit = syncRateLimit('device', 120, deviceKey);
export const uploadRateLimit = syncRateLimit('upload', 300, deviceKey);

import type { NextFunction, Request, Response } from 'express';
import { PROTOCOL_VERSION, type Device } from '@picassio/sync-core';
import { authenticateSyncToken, leaseSyncRuntime } from '../services/sync-runtime.js';
import { currentVaultId, enterVault } from '../services/vault-context.js';

declare global {
  namespace Express {
    interface Request { syncDevice?: Device; syncAuthSource?: 'bearer' | 'browser-cookie'; syncVaultId?: string }
  }
}

export function requireSecureSyncTransport(req: Request, res: Response, next: NextFunction): void {
  const address = req.socket.remoteAddress ?? '';
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
  if (!req.secure && !loopback) {
    syncError(res, 403, 'insecure_transport', 'HTTPS is required outside loopback', false);
    return;
  }
  next();
}

export const BROWSER_SYNC_COOKIE = 'wo_sync_device';
export function browserSyncCookie(vaultId: string): string {
  return `${BROWSER_SYNC_COOKIE}_${vaultId}`;
}

export async function requireSyncDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const bearerToken = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const selectedVaultId = currentVaultId();
  const scopedCookie = selectedVaultId ? req.cookies?.[browserSyncCookie(selectedVaultId)] : undefined;
  const legacyCookie = req.cookies?.[BROWSER_SYNC_COOKIE];
  const cookieToken = typeof scopedCookie === 'string' ? scopedCookie : (typeof legacyCookie === 'string' ? legacyCookie : '');
  const token = bearerToken || cookieToken;
  if (!token) {
    syncError(res, 401, 'authentication_required', 'Device token is required', false);
    return;
  }
  const authenticated = await authenticateSyncToken(token);
  if (!authenticated.device || !authenticated.runtime) {
    const revoked = authenticated.reason === 'revoked';
    syncError(res, revoked ? 403 : 401, revoked ? 'device_revoked' : 'token_invalid', revoked ? 'Device is revoked' : 'Device token is invalid', false);
    return;
  }
  // The credential, never a caller-controlled header, chooses and leases the sync runtime.
  const release = leaseSyncRuntime(authenticated.runtime);
  if (!release) {
    syncError(res, 503, 'vault_unavailable', 'The paired vault is draining', true);
    return;
  }
  res.once('finish', release);
  res.once('close', release);
  enterVault(authenticated.runtime.context);
  req.syncDevice = authenticated.device;
  req.syncVaultId = authenticated.runtime.context.vaultId;
  req.syncAuthSource = bearerToken ? 'bearer' : 'browser-cookie';
  if (!bearerToken && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    const expected = `${req.protocol}://${req.get('host')}`;
    if (origin !== expected || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
      syncError(res, 403, 'scope_denied', 'Browser sync mutation requires a same-origin request', false);
      return;
    }
  }
  next();
}

export function syncError(
  res: Response,
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): void {
  res.status(status).json({
    protocolVersion: PROTOCOL_VERSION,
    error: { code, message, retryable, ...(details ? { details } : {}) },
  });
}

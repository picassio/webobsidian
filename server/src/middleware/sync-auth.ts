import type { NextFunction, Request, Response } from 'express';
import { PROTOCOL_VERSION, type Device } from '@webobsidian/sync-core';
import { getSyncDeviceStore } from '../services/sync-runtime.js';

declare global {
  namespace Express {
    interface Request { syncDevice?: Device; syncAuthSource?: 'bearer' | 'browser-cookie' }
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

export async function requireSyncDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const bearerToken = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const cookieToken = typeof req.cookies?.[BROWSER_SYNC_COOKIE] === 'string' ? req.cookies[BROWSER_SYNC_COOKIE] : '';
  const token = bearerToken || cookieToken;
  if (!token) {
    syncError(res, 401, 'authentication_required', 'Device token is required', false);
    return;
  }
  const authenticated = await getSyncDeviceStore().authenticateDetailed(token);
  if (!authenticated.device) {
    const revoked = authenticated.reason === 'revoked';
    syncError(res, revoked ? 403 : 401, revoked ? 'device_revoked' : 'token_invalid', revoked ? 'Device is revoked' : 'Device token is invalid', false);
    return;
  }
  req.syncDevice = authenticated.device;
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

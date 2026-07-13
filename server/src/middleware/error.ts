import type { Request, Response, NextFunction } from 'express';
import { redactUrlCreds } from '../lib/redact.js';
import { CoordinatorError } from '../sync/coordinator.js';

/** Wrap async route handlers so rejections hit the error middleware. */
export function asyncHandler<T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  const coordinatorStatus = err instanceof CoordinatorError
    ? ({
        revision_conflict: 409,
        path_collision: 409,
        client_sequence_reused: 409,
        hash_mismatch: 400,
        invalid_request: 400,
        cursor_expired: 410,
        sync_read_only: 503,
      } as const)[err.code]
    : undefined;
  const status = coordinatorStatus ?? err?.status ?? 500;
  // Redact any URL-embedded credentials (e.g. a Git PAT baked into an
  // authenticated remote URL) before this message hits the client OR the logs.
  const message = redactUrlCreds(err?.message ?? 'Internal Server Error');
  if (status >= 500) console.error('[error]', message, err?.stack ? `\n${redactUrlCreds(err.stack)}` : '');
  res.status(status).json({
    error: message,
    ...(err instanceof CoordinatorError ? { code: err.code, details: err.details } : {}),
  });
}

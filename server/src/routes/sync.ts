import { Router, type Response } from 'express';
import { promises as fs } from 'node:fs';
import {
  AckRequestSchema,
  BlobUploadCreateRequestSchema,
  ConflictResolutionRequestSchema,
  DEFAULT_LIMITS,
  IdSchema,
  Sha256Schema,
  HandshakeRequestSchema,
  OperationsRequestSchema,
  PairingCodeRequestSchema,
  PairRequestSchema,
  PROTOCOL_VERSION,
} from '@webobsidian/sync-core';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { BROWSER_SYNC_COOKIE, requireSecureSyncTransport, requireSyncDevice, syncError } from '../middleware/sync-auth.js';
import { deviceRateLimit, pairingRateLimit, preAuthSyncRateLimit, requireSyncAdminCsrf, uploadRateLimit } from '../middleware/sync-rate-limit.js';
import { getSyncBlobStore, getSyncCoordinator, getSyncDeviceStore, getSyncMaintenanceStatus, getSyncUploadStore } from '../services/sync-runtime.js';
import { wsTickets } from '../sync/ws-tickets.js';
import { ManifestExpiredError, manifestSnapshots } from '../sync/manifest-snapshots.js';
import { CoordinatorError } from '../sync/coordinator.js';
import { sendFileWithRange } from '../services/httpfile.js';
import { SyncDoctor } from '../sync/doctor.js';
import { config } from '../config.js';
import { getSettings } from '../services/settings.js';
import { syncTransferMetrics } from '../sync/metrics.js';
import { JournalStore } from '../sync/journal.js';
import * as git from '../services/git.js';
import { disconnectSyncWebSockets } from '../sync/ws-registry.js';

export const syncRouter = Router();
syncRouter.use(requireSecureSyncTransport, preAuthSyncRateLimit);

syncRouter.post('/pairing-codes', requireAuth, requireSyncAdminCsrf, pairingRateLimit, asyncHandler(async (req, res) => {
  const syncSettings = (await getSettings()).sync;
  if (!syncSettings.enabled || syncSettings.bootstrapState !== 'ready') {
    return syncError(res, 409, 'temporarily_unavailable', 'Complete the Git backup migration before enabling Central Sync', false);
  }
  const parsed = PairingCodeRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return syncError(res, 400, 'invalid_request', 'Invalid pairing-code request', false, { issues: parsed.error.issues });
  const result = await getSyncDeviceStore().createPairingCode(parsed.data.deviceNameHint);
  res.status(201).json({ protocolVersion: PROTOCOL_VERSION, ...result });
}));

syncRouter.post('/browser-devices', requireAuth, requireSyncAdminCsrf, pairingRateLimit, asyncHandler(async (req, res) => {
  const syncSettings = (await getSettings()).sync;
  if (!syncSettings.enabled || syncSettings.bootstrapState !== 'ready') {
    return syncError(res, 409, 'temporarily_unavailable', 'Complete the Git backup migration before enabling Central Sync', false);
  }
  const deviceId = IdSchema.safeParse(req.body?.deviceId);
  const deviceName = typeof req.body?.deviceName === 'string' ? req.body.deviceName.trim() : '';
  if (!deviceId.success || !deviceName || deviceName.length > 128) {
    return syncError(res, 400, 'invalid_request', 'Invalid browser device identity', false);
  }
  const issued = await getSyncDeviceStore().createPairingCode(deviceName);
  const paired = await getSyncDeviceStore().pair(issued.code, deviceId.data, deviceName);
  const state = await getSyncCoordinator().protocolState();
  res.cookie(BROWSER_SYNC_COOKIE, paired.token, {
    httpOnly: true, secure: req.secure, sameSite: 'strict', path: '/api/sync/v1',
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
  res.status(201).json({ protocolVersion: PROTOCOL_VERSION, vaultId: state.vaultId, deviceId: paired.device.deviceId });
}));

syncRouter.post('/browser-device/upgrade', requireAuth, requireSyncAdminCsrf, pairingRateLimit, asyncHandler(async (req, res) => {
  if (typeof req.body?.token !== 'string' || req.body.token.length > 512) {
    return syncError(res, 400, 'invalid_request', 'Legacy browser credential is required', false);
  }
  try {
    const rotated = await getSyncDeviceStore().rotateToken(req.body.token);
    disconnectSyncWebSockets(rotated.device.deviceId);
    res.cookie(BROWSER_SYNC_COOKIE, rotated.token, {
      httpOnly: true, secure: req.secure, sameSite: 'strict', path: '/api/sync/v1',
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
    res.json({ protocolVersion: PROTOCOL_VERSION, deviceId: rotated.device.deviceId });
  } catch {
    syncError(res, 401, 'token_invalid', 'Legacy browser credential is invalid or revoked', false);
  }
}));

syncRouter.post('/browser-device/logout', requireAuth, requireSyncAdminCsrf, asyncHandler(async (_req, res) => {
  res.clearCookie(BROWSER_SYNC_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/api/sync/v1' });
  res.status(204).end();
}));

syncRouter.post('/pair', pairingRateLimit, asyncHandler(async (req, res) => {
  if (rejectUnsupportedProtocol(req.body, res)) return;
  const parsed = PairRequestSchema.safeParse(req.body);
  if (!parsed.success) return syncError(res, 400, 'invalid_request', 'Invalid pairing request', false, { issues: parsed.error.issues });
  if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
    return syncError(res, 426, 'protocol_incompatible', `Server supports protocol ${PROTOCOL_VERSION}`, false);
  }
  try {
    const paired = await getSyncDeviceStore().pair(parsed.data.code, parsed.data.deviceId, parsed.data.deviceName);
    const state = await getSyncCoordinator().protocolState();
    res.status(201).json({ protocolVersion: PROTOCOL_VERSION, vaultId: state.vaultId, deviceId: paired.device.deviceId, token: paired.token });
  } catch (error) {
    syncError(res, 401, 'token_invalid', error instanceof Error ? error.message : 'Pairing failed', false);
  }
}));

syncRouter.post('/handshake', requireSyncDevice, deviceRateLimit, asyncHandler(async (req, res) => {
  if (rejectUnsupportedProtocol(req.body, res)) return;
  const parsed = HandshakeRequestSchema.safeParse(req.body);
  if (!parsed.success) return syncError(res, 400, 'invalid_request', 'Invalid handshake', false, { issues: parsed.error.issues });
  if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
    return syncError(res, 426, 'protocol_incompatible', `Server supports protocol ${PROTOCOL_VERSION}`, false);
  }
  if (parsed.data.deviceId && parsed.data.deviceId !== req.syncDevice!.deviceId) {
    return syncError(res, 403, 'scope_denied', 'Token is bound to a different device', false);
  }
  const state = await getSyncCoordinator().protocolState();
  res.json({
    protocolVersion: PROTOCOL_VERSION,
    vaultId: state.vaultId,
    deviceId: req.syncDevice!.deviceId,
    latestSequence: state.latestSequence,
    minimumRetainedSequence: state.minimumRetainedSequence,
    readOnly: state.readOnly,
    limits: DEFAULT_LIMITS,
    capabilities: ['manifest-v1', 'changes-v1', 'operations-v1', 'blob-range-v1', 'resumable-blob-v1', 'conflicts-v1'],
  });
}));

syncRouter.get('/manifest', requireSyncDevice, deviceRateLimit, asyncHandler(async (req, res) => {
  const limit = Math.min(DEFAULT_LIMITS.manifestPageSize, Math.max(1, Number(req.query.limit ?? DEFAULT_LIMITS.manifestPageSize)));
  if (!Number.isSafeInteger(limit)) return syncError(res, 400, 'invalid_request', 'Invalid manifest limit', false);
  if (typeof req.query.cursor !== 'string') {
    const captured = await getSyncCoordinator().captureManifest();
    res.json({ protocolVersion: PROTOCOL_VERSION, ...manifestSnapshots.create(captured.entries, captured.sequence, limit) });
    return;
  }
  try {
    res.json({ protocolVersion: PROTOCOL_VERSION, ...manifestSnapshots.page(req.query.cursor, limit) });
  } catch (error) {
    if (error instanceof ManifestExpiredError) return syncError(res, 410, 'manifest_expired', error.message, false);
    throw error;
  }
}));

syncRouter.get('/changes', requireSyncDevice, deviceRateLimit, asyncHandler(async (req, res) => {
  const after = Number(req.query.after ?? 0);
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 500)));
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit)) {
    return syncError(res, 400, 'invalid_request', 'Invalid changes cursor or limit', false);
  }
  try {
    const changes = await getSyncCoordinator().changesAfter(after, limit);
    res.json({
      protocolVersion: PROTOCOL_VERSION,
      latestSequence: changes.latestSequence,
      nextAfter: changes.events.at(-1)?.sequence ?? after,
      hasMore: changes.hasMore,
      events: changes.events,
    });
  } catch (error) {
    if (error instanceof CoordinatorError && error.code === 'cursor_expired') {
      return syncError(res, 410, 'cursor_expired', error.message, false, error.details);
    }
    throw error;
  }
}));

syncRouter.post('/ack', requireSyncDevice, deviceRateLimit, asyncHandler(async (req, res) => {
  if (rejectUnsupportedProtocol(req.body, res)) return;
  const parsed = AckRequestSchema.safeParse(req.body);
  if (!parsed.success) return syncError(res, 400, 'invalid_request', 'Invalid acknowledgement', false);
  const state = await getSyncCoordinator().protocolState();
  if (parsed.data.sequence > state.latestSequence) {
    return syncError(res, 400, 'invalid_request', 'Cannot acknowledge a future sequence', false);
  }
  try {
    const device = await getSyncDeviceStore().acknowledge(req.syncDevice!.deviceId, parsed.data.sequence);
    res.json({ protocolVersion: PROTOCOL_VERSION, acknowledgedSequence: device.acknowledgedSequence });
  } catch (error) {
    syncError(res, 400, 'invalid_request', error instanceof Error ? error.message : 'Acknowledgement failed', false);
  }
}));

syncRouter.post('/operations', requireSyncDevice, deviceRateLimit, asyncHandler(async (req, res) => {
  if (rejectUnsupportedProtocol(req.body, res)) return;
  const parsed = OperationsRequestSchema.safeParse(req.body);
  if (!parsed.success) return syncError(res, 400, 'invalid_request', 'Invalid operations batch', false, { issues: parsed.error.issues });
  if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
    return syncError(res, 426, 'protocol_incompatible', `Server supports protocol ${PROTOCOL_VERSION}`, false);
  }
  const outcomes = new Map<string, 'success' | 'failed'>();
  const results = [];
  for (const operation of parsed.data.operations) {
    const dependencyFailed = operation.dependsOn?.some((key) => outcomes.get(key) !== 'success') ?? false;
    if (dependencyFailed) {
      getSyncCoordinator().recordDependencyFailure();
      results.push({ idempotencyKey: operation.idempotencyKey, status: 'dependency_failed' as const, errorCode: 'dependency_failed' });
      outcomes.set(operation.idempotencyKey, 'failed');
      continue;
    }
    try {
      const result = await getSyncCoordinator().apply(operation, { type: 'device', id: req.syncDevice!.deviceId });
      results.push(result);
      outcomes.set(operation.idempotencyKey, result.status === 'accepted' || result.status === 'merged' ? 'success' : 'failed');
    } catch (error) {
      if (error instanceof CoordinatorError) {
        results.push({ idempotencyKey: operation.idempotencyKey, status: 'rejected' as const, errorCode: error.code });
        outcomes.set(operation.idempotencyKey, 'failed');
        continue;
      }
      throw error;
    }
  }
  res.json({ protocolVersion: PROTOCOL_VERSION, latestSequence: (await getSyncCoordinator().protocolState()).latestSequence, results });
}));

syncRouter.get('/conflicts', requireSyncDevice, deviceRateLimit, asyncHandler(async (_req, res) => {
  res.json({ protocolVersion: PROTOCOL_VERSION, conflicts: await getSyncCoordinator().listConflicts() });
}));

syncRouter.get('/conflicts/:conflictId', requireSyncDevice, deviceRateLimit, asyncHandler(async (req, res) => {
  const conflict = await getSyncCoordinator().conflict(req.params.conflictId);
  if (!conflict) return syncError(res, 404, 'invalid_request', 'Conflict not found', false);
  res.json({ protocolVersion: PROTOCOL_VERSION, conflict });
}));

syncRouter.post('/conflicts/:conflictId/resolve', requireSyncDevice, deviceRateLimit, asyncHandler(async (req, res) => {
  if (rejectUnsupportedProtocol(req.body, res)) return;
  const parsed = ConflictResolutionRequestSchema.safeParse(req.body);
  if (!parsed.success) return syncError(res, 400, 'invalid_request', 'Invalid conflict resolution', false, { issues: parsed.error.issues });
  if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
    return syncError(res, 426, 'protocol_incompatible', `Server supports protocol ${PROTOCOL_VERSION}`, false);
  }
  try {
    const resolved = await getSyncCoordinator().resolveConflict(
      req.params.conflictId,
      parsed.data.resolution,
      { type: 'device', id: req.syncDevice!.deviceId },
      { clientSequence: parsed.data.clientSequence, idempotencyKey: parsed.data.idempotencyKey },
      parsed.data.mergedContent,
    );
    res.json({ protocolVersion: PROTOCOL_VERSION, ...resolved });
  } catch (error) {
    if (error instanceof CoordinatorError) {
      return syncError(res, error.code === 'revision_conflict' ? 409 : 400, error.code, error.message, false, error.details);
    }
    throw error;
  }
}));

syncRouter.get(['/files', '/files/:entryId'], requireSyncDevice, deviceRateLimit, asyncHandler(async (req, res) => {
  const entryId = IdSchema.safeParse(req.params.entryId ?? req.query.entryId);
  const revision = req.query.revision === undefined ? undefined : Number(req.query.revision);
  if (!entryId.success || (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))) {
    return syncError(res, 400, 'invalid_request', 'Invalid entry id or revision', false);
  }
  const file = await getSyncCoordinator().fileRevision(entryId.data, revision);
  if (!file) return syncError(res, 410, 'revision_expired', 'File revision is unavailable', false);
  res.setHeader('ETag', `\"${file.hash}\"`);
  res.setHeader('X-Entry-Id', file.entryId);
  res.setHeader('X-Revision', String(file.revision));
  res.setHeader('X-Content-SHA256', file.hash);
  await sendFileWithRange(req, res, file.file, 'application/octet-stream');
}));

syncRouter.head('/blobs/:hash', requireSyncDevice, deviceRateLimit, asyncHandler(async (req, res) => {
  const hash = Sha256Schema.safeParse(req.params.hash);
  if (!hash.success) return syncError(res, 400, 'invalid_request', 'Invalid blob hash', false);
  const blob = await getSyncBlobStore().get(hash.data);
  if (!blob) return syncError(res, 404, 'invalid_request', 'Blob not found', false);
  res.setHeader('Content-Length', String(blob.size));
  res.setHeader('ETag', `\"${blob.hash}\"`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.status(200).end();
}));

syncRouter.get('/blobs/:hash', requireSyncDevice, deviceRateLimit, asyncHandler(async (req, res) => {
  const hash = Sha256Schema.safeParse(req.params.hash);
  if (!hash.success) return syncError(res, 400, 'invalid_request', 'Invalid blob hash', false);
  const blob = await getSyncBlobStore().get(hash.data);
  if (!blob) return syncError(res, 404, 'invalid_request', 'Blob not found', false);
  res.setHeader('ETag', `\"${blob.hash}\"`);
  await sendFileWithRange(req, res, blob.file, 'application/octet-stream');
}));

syncRouter.post('/blob-uploads', requireSyncDevice, deviceRateLimit, uploadRateLimit, asyncHandler(async (req, res) => {
  if (rejectUnsupportedProtocol(req.body, res)) return;
  const parsed = BlobUploadCreateRequestSchema.safeParse(req.body);
  if (!parsed.success) return syncError(res, 400, 'invalid_request', 'Invalid blob upload request', false, { issues: parsed.error.issues });
  try {
    const upload = await getSyncUploadStore().create(
      req.syncDevice!.deviceId, parsed.data.hash, parsed.data.size, parsed.data.chunkSize,
    );
    res.status(201).json({ protocolVersion: PROTOCOL_VERSION, ...upload });
  } catch (error) {
    const quota = error instanceof Error && /quota/.test(error.message);
    syncError(res, quota ? 413 : 400, quota ? 'quota_exceeded' : 'invalid_request', error instanceof Error ? error.message : 'Upload failed', false);
  }
}));

syncRouter.put('/blob-uploads/:uploadId/:part', requireSyncDevice, deviceRateLimit, uploadRateLimit, asyncHandler(async (req, res) => {
  try {
    await getSyncUploadStore().putPart(req.syncDevice!.deviceId, req.params.uploadId, Number(req.params.part), req);
    res.status(204).end();
  } catch (error) {
    const tooLarge = error instanceof Error && /exceeds/.test(error.message);
    syncError(res, tooLarge ? 413 : 400, tooLarge ? 'payload_too_large' : 'invalid_request', error instanceof Error ? error.message : 'Part upload failed', false);
  }
}));

syncRouter.post('/blob-uploads/:uploadId/complete', requireSyncDevice, deviceRateLimit, uploadRateLimit, asyncHandler(async (req, res) => {
  try {
    const completed = await getSyncUploadStore().complete(req.syncDevice!.deviceId, req.params.uploadId);
    syncTransferMetrics.recordUpload(completed.size, completed.deduplicated);
    res.json({ protocolVersion: PROTOCOL_VERSION, ...completed });
  } catch (error) {
    const mismatch = error instanceof Error && /hash mismatch/.test(error.message);
    syncError(res, 400, mismatch ? 'hash_mismatch' : 'invalid_request', error instanceof Error ? error.message : 'Upload completion failed', false);
  }
}));

syncRouter.post('/ws-tickets', requireSyncDevice, deviceRateLimit, asyncHandler(async (req, res) => {
  const issued = wsTickets.issue(req.syncDevice!.deviceId);
  res.status(201).json({ protocolVersion: PROTOCOL_VERSION, ...issued });
}));

syncRouter.get('/health', requireAuth, asyncHandler(async (_req, res) => {
  const coordinator = getSyncCoordinator();
  const health = coordinator.health();
  const devices = await getSyncDeviceStore().list();
  const segments = await new JournalStore(config.dataDir).segments();
  const journalBytes = (await Promise.all(segments.map((segment) => fs.stat(segment.file).then((item) => item.size).catch(() => 0)))).reduce((sum, size) => sum + size, 0);
  const gitStatus = await git.status().catch(() => null);
  const gitBackup = gitStatus ? {
    enabled: gitStatus.enabled, isRepo: gitStatus.isRepo, branch: gitStatus.branch,
    ahead: gitStatus.ahead, behind: gitStatus.behind, clean: gitStatus.clean,
    conflicted: gitStatus.conflicted.length, lfsAvailable: gitStatus.lfsAvailable,
  } : { error: 'Git backup status unavailable' };
  const deviceMetrics = devices.map(({ deviceId, acknowledgedSequence, revokedAt, lastSeenAt }) => ({
    deviceId, acknowledgedSequence, lag: Math.max(0, health.latestSequence - acknowledgedSequence), revoked: revokedAt !== null, lastSeenAt,
  }));
  const alerts = [
    ...(health.readOnly ? [{ severity: 'critical', code: 'sync_read_only', message: health.reason ?? 'Sync is read-only' }] : []),
    ...(health.indexLagSequence > 100 ? [{ severity: 'warning', code: 'derived_index_lag', message: `Derived index is ${health.indexLagSequence} revisions behind` }] : []),
    ...deviceMetrics.filter((device) => !device.revoked && device.lag > 1_000).map((device) => ({ severity: 'warning', code: 'device_lag', message: `${device.deviceId} is ${device.lag} revisions behind` })),
  ];
  res.json({
    protocolVersion: PROTOCOL_VERSION,
    ...health,
    alerts,
    metrics: {
      ...health.metrics,
      transfers: syncTransferMetrics.snapshot(),
      journal: {
        segments: segments.length, bytes: journalBytes,
        earliestSequence: segments.find((segment) => segment.eventCount > 0)?.firstSequence ?? null,
      },
      maintenance: getSyncMaintenanceStatus(),
      gitBackup,
      devices: deviceMetrics,
    },
  });
}));

syncRouter.get('/metrics', requireAuth, asyncHandler(async (_req, res) => {
  const coordinator = getSyncCoordinator();
  const health = coordinator.health();
  const transfers = syncTransferMetrics.snapshot();
  const devices = await getSyncDeviceStore().list();
  const lines = [
    '# HELP webobsidian_sync_latest_sequence Latest authoritative sequence.',
    '# TYPE webobsidian_sync_latest_sequence gauge',
    `webobsidian_sync_latest_sequence ${health.latestSequence}`,
    '# TYPE webobsidian_sync_index_lag gauge',
    `webobsidian_sync_index_lag ${health.indexLagSequence}`,
    '# TYPE webobsidian_sync_operations_total counter',
    ...Object.entries(health.metrics.operations).map(([status, value]) => `webobsidian_sync_operations_total{status="${status}"} ${value}`),
    '# TYPE webobsidian_sync_operation_latency_ms gauge',
    `webobsidian_sync_operation_latency_ms{stat="average"} ${health.metrics.latency.averageMs}`,
    `webobsidian_sync_operation_latency_ms{stat="max"} ${health.metrics.latency.maxMs}`,
    '# TYPE webobsidian_sync_transfer_bytes_total counter',
    `webobsidian_sync_transfer_bytes_total{kind="uploaded"} ${transfers.uploadedBytes}`,
    `webobsidian_sync_transfer_bytes_total{kind="deduplicated"} ${transfers.deduplicatedBytes}`,
    '# TYPE webobsidian_sync_device_lag gauge',
    ...devices.map((device) => `webobsidian_sync_device_lag{device_id="${device.deviceId}"} ${Math.max(0, health.latestSequence - device.acknowledgedSequence)}`),
    '# TYPE webobsidian_sync_read_only gauge',
    `webobsidian_sync_read_only ${health.readOnly ? 1 : 0}`,
  ];
  res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
}));

syncRouter.get('/doctor', requireAuth, deviceRateLimit, asyncHandler(async (_req, res) => {
  const report = await new SyncDoctor(config.dataDir, getSyncCoordinator().vaultRootPath()).run();
  res.json({ protocolVersion: PROTOCOL_VERSION, ...report });
}));

syncRouter.get('/devices', requireAuth, asyncHandler(async (_req, res) => {
  res.json({ protocolVersion: PROTOCOL_VERSION, devices: await getSyncDeviceStore().list() });
}));

syncRouter.delete('/devices/:deviceId', requireAuth, requireSyncAdminCsrf, pairingRateLimit, asyncHandler(async (req, res) => {
  try {
    await getSyncDeviceStore().revoke(req.params.deviceId);
    disconnectSyncWebSockets(req.params.deviceId);
    res.status(204).end();
  } catch (error) {
    syncError(res, 404, 'invalid_request', error instanceof Error ? error.message : 'Unknown device', false);
  }
}));

function rejectUnsupportedProtocol(body: unknown, res: Response): boolean {
  const protocolVersion = typeof body === 'object' && body !== null
    ? (body as { protocolVersion?: unknown }).protocolVersion
    : undefined;
  if (typeof protocolVersion !== 'string' || !/^\d+\.\d+$/.test(protocolVersion) || protocolVersion === PROTOCOL_VERSION) return false;
  syncError(res, 426, 'protocol_incompatible', `Server supports protocol ${PROTOCOL_VERSION}`, false);
  return true;
}

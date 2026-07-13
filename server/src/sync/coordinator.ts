import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  MAX_AUTO_MERGE_BYTES,
  SyncOperationSchema,
  conflictCopyPath,
  evaluatePathPolicy,
  mergeText,
  sha256Chunks,
  sha256Text,
  type Conflict,
  type OperationResult,
  type SyncEntry,
  type SyncEvent,
  type SyncOperation,
} from '@picassio/sync-core';
import { MergeBaseStore } from './base-store.js';
import { BlobStore } from './blob-store.js';
import { ConflictStore } from './conflict-store.js';
import { DerivedEventQueue } from './derived-queue.js';
import { IdempotencyConflictError, IdempotencyStore } from './idempotency-store.js';
import { TransactionIntentStore, type TransactionIntent } from './intents.js';
import { JournalStore } from './journal.js';
import { AsyncMutex, SubtreeLockManager } from './locks.js';
import { RevisionStore, scanVaultSnapshot } from './revision-store.js';
import { TrashStore, type TrashRecord } from './trash-store.js';
import { VaultStateStore } from './vault-state.js';

export type CommittedEventSubscriber = (event: SyncEvent) => void | Promise<void>;
export const LEGACY_WEB_ACTOR = { type: 'legacy' as const, id: 'legacy_web_routes_1' };
export const SERVER_FS_ACTOR = { type: 'server-fs' as const, id: 'server_filesystem_1' };
export type BlobResolver = (hash: string) => Promise<string>;

export class CoordinatorError extends Error {
  constructor(
    public readonly code: 'revision_conflict' | 'path_collision' | 'hash_mismatch' | 'invalid_request' | 'client_sequence_reused' | 'cursor_expired' | 'sync_read_only',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CoordinatorError';
  }
}

export type CoordinatorCrashPoint =
  | 'after_intent'
  | 'after_materialize'
  | 'after_materialized_marker'
  | 'after_journal_commit'
  | 'after_revision_snapshot'
  | 'after_idempotency_snapshot';

export class SimulatedProcessCrash extends Error {
  constructor(public readonly point: CoordinatorCrashPoint) {
    super(`simulated process crash at ${point}`);
    this.name = 'SimulatedProcessCrash';
  }
}

export interface ImportPlan {
  createFiles: string[];
  modifyFiles: string[];
  createDirectories: string[];
  deletePaths: string[];
  conflicts: Array<{ path: string; sourceKind: string; currentKind: string }>;
  unchanged: number;
}

export interface SyncCoordinatorOptions {
  vaultRoot: string;
  dataDir: string;
  resolveBlob?: BlobResolver;
  /** Test-only hard-crash injection; throwing SimulatedProcessCrash bypasses rollback. */
  faultInjector?: (point: CoordinatorCrashPoint) => void | Promise<void>;
}

/** The only authoritative vault mutation pipeline. */
export class SyncCoordinator {
  private readonly journal: JournalStore;
  private readonly revisions: RevisionStore;
  private readonly vaultState: VaultStateStore;
  private readonly intents: TransactionIntentStore;
  private readonly idempotency: IdempotencyStore;
  private readonly blobs: BlobStore;
  private readonly bases: MergeBaseStore;
  private readonly conflicts: ConflictStore;
  private readonly trash: TrashStore;
  private readonly derivedQueue: DerivedEventQueue;
  private readonly pathLocks = new SubtreeLockManager();
  private readonly commitLock = new AsyncMutex();
  private readonly subscribers = new Set<CommittedEventSubscriber>();
  private root = '';
  private initialized = false;
  private degradedReason: string | null = null;
  private legacyClientSequence = 0;
  private externalClientSequence = 0;
  private readonly watcherSuppressions = new Map<string, { exists: boolean; hash: string | null; expiresAt: number }>();
  private latestSequence = 0;
  private derivedRetryTimer: NodeJS.Timeout | null = null;
  private readonly metricsStartedAt = new Date().toISOString();
  private readonly operationMetrics = { accepted: 0, merged: 0, conflict: 0, rejected: 0, dependencyFailed: 0, deduplicated: 0 };
  private operationLatencyCount = 0;
  private operationLatencyTotalMs = 0;
  private operationLatencyMaxMs = 0;
  private driftRepairs = 0;

  constructor(private readonly options: SyncCoordinatorOptions) {
    this.journal = new JournalStore(options.dataDir);
    this.revisions = new RevisionStore(options.dataDir);
    this.vaultState = new VaultStateStore(options.dataDir);
    this.intents = new TransactionIntentStore(options.dataDir);
    this.idempotency = new IdempotencyStore(options.dataDir);
    this.blobs = new BlobStore(options.dataDir);
    this.bases = new MergeBaseStore(options.dataDir, this.blobs);
    this.conflicts = new ConflictStore(options.dataDir);
    this.trash = new TrashStore(options.dataDir);
    this.derivedQueue = new DerivedEventQueue(options.dataDir);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      this.root = await fs.realpath(this.options.vaultRoot);
      await this.vaultState.loadOrCreate();
      await this.revisions.initializeFromVault(this.root);
      await this.ensureCurrentBlobs();
      await this.validateAndReplay();
      this.latestSequence = await this.journal.latestSequence();
      await this.derivedQueue.initializeAt(this.latestSequence);
      await this.recoverIntents();
      await this.validateAndReplay();
      this.legacyClientSequence = await this.idempotency.highestClientSequence(LEGACY_WEB_ACTOR.id);
      this.externalClientSequence = await this.idempotency.highestClientSequence(SERVER_FS_ACTOR.id);
      this.initialized = true;
      await this.reconcileExternalDrift();
    } catch (error) {
      this.degradedReason = error instanceof Error ? error.message : String(error);
    } finally {
      this.initialized = true;
    }
  }

  health(): {
    initialized: boolean;
    readOnly: boolean;
    reason: string | null;
    latestSequence: number;
    indexLagSequence: number;
    derivedQueue: ReturnType<DerivedEventQueue['status']>;
    metrics: {
      startedAt: string;
      operations: { accepted: number; merged: number; conflict: number; rejected: number; dependencyFailed: number; deduplicated: number };
      latency: { count: number; averageMs: number; maxMs: number };
      driftRepairs: number;
    };
  } {
    const derivedQueue = this.derivedQueue.status();
    return {
      initialized: this.initialized,
      readOnly: this.degradedReason !== null,
      reason: this.degradedReason,
      latestSequence: this.latestSequence,
      indexLagSequence: Math.max(0, this.latestSequence - derivedQueue.appliedSequence),
      derivedQueue,
      metrics: {
        startedAt: this.metricsStartedAt,
        operations: { ...this.operationMetrics },
        latency: {
          count: this.operationLatencyCount,
          averageMs: this.operationLatencyCount ? this.operationLatencyTotalMs / this.operationLatencyCount : 0,
          maxMs: this.operationLatencyMaxMs,
        },
        driftRepairs: this.driftRepairs,
      },
    };
  }

  vaultRootPath(): string { return this.root; }

  async flushProjection(): Promise<void> { await this.revisions.flushProjection(); }

  recordDependencyFailure(): void { this.operationMetrics.dependencyFailed += 1; }

  async fileRevision(entryId: string, revision?: number): Promise<{ entryId: string; revision: number; hash: string; size: number; path: string; file: string } | null> {
    const current = await this.revisions.getById(entryId);
    if (current && !current.deleted && current.kind === 'file' && (revision === undefined || revision === current.revision) && current.hash) {
      const blob = await this.blobs.get(current.hash);
      if (!blob) throw new Error(`current blob missing for ${entryId}`);
      return { entryId, revision: current.revision, hash: current.hash, size: current.size, path: current.path, file: blob.file };
    }
    if (revision === undefined) return null;
    const event = (await this.journal.replay()).find(
      (item) => item.entryId === entryId && item.revision === revision && item.hash,
    );
    if (!event?.hash) return null;
    const blob = await this.blobs.get(event.hash);
    return blob ? { entryId, revision, hash: event.hash, size: event.size, path: event.path, file: blob.file } : null;
  }

  async changesAfter(after: number, limit: number): Promise<{ events: SyncEvent[]; latestSequence: number; hasMore: boolean }> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new CoordinatorError('invalid_request', 'invalid changes cursor or limit');
    }
    const earliest = await this.journal.earliestSequence();
    if (earliest !== null && after < earliest - 1) {
      throw new CoordinatorError('cursor_expired', 'Requested cursor is no longer retained', { cursor: after, earliestAvailable: earliest });
    }
    const all = await this.journal.replay(after);
    return { events: all.slice(0, limit), latestSequence: await this.journal.latestSequence(), hasMore: all.length > limit };
  }

  async captureManifest(): Promise<{ sequence: number; entries: SyncEntry[] }> {
    return this.commitLock.run(async () => {
      const snapshot = await this.revisions.load();
      return { sequence: snapshot!.currentSequence, entries: snapshot!.entries.map((entry) => ({ ...entry })) };
    });
  }

  async protocolState(): Promise<{ vaultId: string; latestSequence: number; minimumRetainedSequence: number; readOnly: boolean }> {
    const vault = await this.vaultState.loadOrCreate();
    const latestSequence = await this.journal.latestSequence();
    return {
      vaultId: vault.vaultId,
      latestSequence,
      minimumRetainedSequence: await this.journal.earliestSequence() ?? latestSequence,
      readOnly: this.degradedReason !== null,
    };
  }

  async entryByPath(pathValue: string): Promise<SyncEntry | null> {
    return this.revisions.getByPath(pathValue);
  }

  async entryById(entryId: string): Promise<SyncEntry | null> {
    return this.revisions.getById(entryId);
  }

  nextLegacyOperationMetadata(): { clientSequence: number; idempotencyKey: string } {
    this.assertWritable();
    const clientSequence = ++this.legacyClientSequence;
    return {
      clientSequence,
      idempotencyKey: `legacy:${clientSequence}:${randomBytes(12).toString('base64url')}`,
    };
  }

  async reconcileExternalDrift(): Promise<number> {
    this.assertWritable();
    const actual = await scanVaultSnapshot(this.root);
    const snapshot = await this.revisions.load();
    const tracked = (snapshot?.entries ?? []).filter((entry) => !entry.deleted);
    const actualByPath = new Map(actual.map((entry) => [entry.path.toLocaleLowerCase('en-US'), entry]));
    const trackedByPath = new Map(tracked.map((entry) => [entry.path.toLocaleLowerCase('en-US'), entry]));
    const missing = tracked.filter((entry) => !actualByPath.has(entry.path.toLocaleLowerCase('en-US')));
    const added = actual.filter((entry) => !trackedByPath.has(entry.path.toLocaleLowerCase('en-US')));
    let changes = 0;
    for (const oldEntry of [...missing]) {
      if (oldEntry.kind !== 'file' || !oldEntry.hash) continue;
      const matches = added.filter((entry) => entry.kind === 'file' && entry.hash === oldEntry.hash);
      if (matches.length !== 1) continue;
      const match = matches[0]!;
      await this.reconcileExternalRename(oldEntry.path, match.path);
      missing.splice(missing.indexOf(oldEntry), 1);
      added.splice(added.indexOf(match), 1);
      changes += 1;
    }
    for (const entry of missing.sort((a, b) => b.path.split('/').length - a.path.split('/').length)) {
      await this.reconcileExternalPath(entry.path, entry.kind === 'directory' ? 'unlinkDir' : 'unlink');
      changes += 1;
    }
    for (const entry of added.sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
      await this.reconcileExternalPath(entry.path, entry.kind === 'directory' ? 'addDir' : 'add');
      changes += 1;
    }
    for (const entry of actual) {
      const current = trackedByPath.get(entry.path.toLocaleLowerCase('en-US'));
      if (current?.kind === 'file' && entry.kind === 'file' && (current.hash !== entry.hash || current.size !== entry.size)) {
        await this.reconcileExternalPath(entry.path, 'change');
        changes += 1;
      }
    }
    this.driftRepairs += changes;
    return changes;
  }

  async reconcileExternalRename(fromInput: string, toInput: string): Promise<OperationResult> {
    this.assertWritable();
    const fromPolicy = evaluatePathPolicy(fromInput.normalize('NFC'));
    const toPolicy = evaluatePathPolicy(toInput.normalize('NFC'));
    if (!fromPolicy.allowed || !toPolicy.allowed) throw new CoordinatorError('invalid_request', 'external rename path is excluded');
    return this.commitLock.run(async () => this.pathLocks.withLock([fromPolicy.path, toPolicy.path], async () => {
      const current = await this.revisions.getByPath(fromPolicy.path);
      if (!current) throw new CoordinatorError('revision_conflict', 'external rename source identity is missing', { from: fromPolicy.path });
      if (await this.revisions.getByPath(toPolicy.path)) throw new CoordinatorError('path_collision', 'external rename destination is tracked', { to: toPolicy.path });
      if (await pathExists(this.absolute(fromPolicy.path)) || !(await pathExists(this.absolute(toPolicy.path)))) {
        throw new CoordinatorError('revision_conflict', 'external rename filesystem state is ambiguous');
      }
      if (current.kind === 'file' && await hashIfFile(this.absolute(toPolicy.path)) !== current.hash) {
        throw new CoordinatorError('revision_conflict', 'external rename content hash changed');
      }
      const metadata = this.nextExternalOperationMetadata();
      const sequence = (await this.vaultState.loadOrCreate()).currentSequence + 1;
      const event: SyncEvent = {
        sequence, eventId: `event_${randomBytes(18).toString('base64url')}`,
        actor: SERVER_FS_ACTOR, operation: 'rename', entryId: current.entryId,
        path: toPolicy.path, oldPath: fromPolicy.path, baseRevision: current.revision,
        revision: current.revision + 1, hash: current.hash, size: current.size,
        occurredAt: new Date().toISOString(),
      };
      const result: OperationResult = {
        idempotencyKey: metadata.idempotencyKey, status: 'accepted', eventId: event.eventId,
        sequence, entryId: event.entryId, revision: event.revision, hash: event.hash, path: event.path,
      };
      const intent = await this.intents.prepare({
        event, result, clientSequence: metadata.clientSequence,
        operationFingerprint: sha256Text(JSON.stringify({ source: 'server-fs-rename', from: fromPolicy.path, to: toPolicy.path, hash: current.hash })),
        targetPath: toPolicy.path, previousPath: fromPolicy.path,
      });
      await this.intents.markMaterialized(intent.transactionId);
      await this.journal.append(event);
      await this.finishCommittedOrDegrade(intent);
      return result;
    }));
  }

  async reconcileExternalPath(
    pathInput: string,
    eventType: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir',
  ): Promise<OperationResult | null> {
    this.assertWritable();
    const policy = evaluatePathPolicy(pathInput.normalize('NFC'));
    if (!policy.allowed) return null;
    const relativePath = policy.path;
    return this.commitLock.run(async () => this.pathLocks.withLock([relativePath], async () => {
      const current = await this.revisions.getByPath(relativePath);
      const exists = eventType !== 'unlink' && eventType !== 'unlinkDir';
      const kind = eventType === 'addDir' || eventType === 'unlinkDir' ? 'directory' : 'file';
      const absolute = this.absolute(relativePath);
      let hash: string | null = null;
      let size = 0;
      if (exists && kind === 'file') {
        const stat = await fs.stat(absolute);
        size = stat.size;
        hash = await sha256Chunks(createReadStream(absolute));
      }
      if (this.consumeWatcherSuppression(relativePath, exists, hash)) return null;
      if (exists && current && current.kind === kind && (kind === 'directory' || (current.hash === hash && current.size === size))) return null;
      if (!exists && !current) return null;
      if (exists && current && current.kind !== kind) {
        throw new CoordinatorError('revision_conflict', 'external file/directory replacement requires ordered delete/create reconciliation', {
          path: relativePath, currentKind: current.kind, actualKind: kind,
        });
      }
      const metadata = this.nextExternalOperationMetadata();
      const sequence = (await this.vaultState.loadOrCreate()).currentSequence + 1;
      const operation = !exists
        ? (current!.kind === 'directory' ? 'rmdir' : 'delete')
        : current
          ? 'modify'
          : kind === 'directory' ? 'mkdir' : 'create';
      const event: SyncEvent = {
        sequence,
        eventId: `event_${randomBytes(18).toString('base64url')}`,
        actor: SERVER_FS_ACTOR,
        operation,
        entryId: current?.entryId ?? `entry_${randomBytes(18).toString('base64url')}`,
        path: relativePath,
        baseRevision: current?.revision ?? null,
        revision: (current?.revision ?? 0) + 1,
        hash: exists ? hash : null,
        ...(current?.hash ? { previousHash: current.hash } : {}),
        size: exists ? size : 0,
        occurredAt: new Date().toISOString(),
      };
      const result: OperationResult = {
        idempotencyKey: metadata.idempotencyKey,
        status: 'accepted', eventId: event.eventId, sequence,
        entryId: event.entryId, revision: event.revision, hash: event.hash, path: event.path,
      };
      const previousBlob = current?.hash ? await this.blobs.get(current.hash) : null;
      const fingerprint = sha256Text(JSON.stringify({ source: 'server-fs', eventType, path: relativePath, hash, size, base: current?.revision ?? null }));
      const intent = await this.intents.prepare({
        event, result,
        clientSequence: metadata.clientSequence,
        operationFingerprint: fingerprint,
        targetPath: relativePath,
        ...(current ? { previousPath: current.path } : {}),
        ...(exists && kind === 'file' ? { newContentSource: absolute } : {}),
        ...(previousBlob ? { previousContentSource: previousBlob.file } : {}),
      });
      try {
        if (!exists) await this.materializeExternalTrash(intent, previousBlob?.file ?? null);
        await this.intents.markMaterialized(intent.transactionId);
        await this.journal.append(event);
      } catch (error) {
        if ((await this.journal.latestSequence()) >= event.sequence) {
          await this.finishCommittedOrDegrade(intent);
          return result;
        }
        await this.rollbackUncommittedOrDegrade(intent);
        throw error;
      }
      await this.finishCommittedOrDegrade(intent);
      return result;
    }));
  }

  async planDirectoryImport(sourceRoot: string, deleteMissing = false): Promise<ImportPlan> {
    const source = await scanVaultSnapshot(sourceRoot);
    const current = (await this.revisions.load())!.entries.filter((entry) => !entry.deleted);
    const currentByPath = new Map(current.map((entry) => [entry.path.toLocaleLowerCase('en-US'), entry]));
    const sourceByPath = new Map(source.map((entry) => [entry.path.toLocaleLowerCase('en-US'), entry]));
    const plan: ImportPlan = {
      createFiles: [], modifyFiles: [], createDirectories: [], deletePaths: [], conflicts: [], unchanged: 0,
    };
    for (const entry of source) {
      const existing = currentByPath.get(entry.path.toLocaleLowerCase('en-US'));
      if (!existing) {
        (entry.kind === 'directory' ? plan.createDirectories : plan.createFiles).push(entry.path);
      } else if (existing.kind !== entry.kind) {
        plan.conflicts.push({ path: entry.path, sourceKind: entry.kind, currentKind: existing.kind });
      } else if (entry.kind === 'file' && (existing.hash !== entry.hash || existing.size !== entry.size)) {
        plan.modifyFiles.push(entry.path);
      } else plan.unchanged += 1;
    }
    if (deleteMissing) {
      plan.deletePaths = current
        .filter((entry) => !sourceByPath.has(entry.path.toLocaleLowerCase('en-US')))
        .sort((a, b) => b.path.split('/').length - a.path.split('/').length)
        .map((entry) => entry.path);
    }
    return plan;
  }

  async importDirectory(
    sourceRoot: string,
    deleteMissing: boolean,
    actor: SyncEvent['actor'],
    nextMetadata: () => { clientSequence: number; idempotencyKey: string },
  ): Promise<{ plan: ImportPlan; results: OperationResult[] }> {
    this.assertWritable();
    const root = await fs.realpath(sourceRoot);
    const plan = await this.planDirectoryImport(root, deleteMissing);
    if (plan.conflicts.length) throw new CoordinatorError('path_collision', 'import has file/directory kind conflicts', { conflicts: plan.conflicts });
    const results: OperationResult[] = [];
    for (const pathValue of plan.deletePaths) {
      const current = await this.revisions.getByPath(pathValue);
      if (!current) continue;
      results.push(await this.apply({
        operation: current.kind === 'directory' ? 'rmdir' : 'delete',
        ...nextMetadata(), entryId: current.entryId, baseRevision: current.revision,
      }, actor));
    }
    for (const pathValue of plan.createDirectories.sort((a, b) => a.split('/').length - b.split('/').length)) {
      results.push(await this.apply({ operation: 'mkdir', ...nextMetadata(), path: pathValue, kind: 'directory' }, actor));
    }
    for (const pathValue of [...plan.createFiles, ...plan.modifyFiles]) {
      const sourceFile = path.resolve(root, ...pathValue.split('/'));
      if (!sourceFile.startsWith(`${root}${path.sep}`)) throw new CoordinatorError('invalid_request', 'import path escapes source');
      const stat = await fs.stat(sourceFile);
      const hash = await sha256Chunks(createReadStream(sourceFile));
      await this.blobs.putFile(sourceFile, hash, stat.size);
      const current = await this.revisions.getByPath(pathValue);
      results.push(await this.apply(current ? {
        operation: 'modify', ...nextMetadata(), entryId: current.entryId, baseRevision: current.revision,
        content: { hash, size: stat.size, blobHash: hash },
      } : {
        operation: 'create', ...nextMetadata(), path: pathValue, kind: 'file',
        content: { hash, size: stat.size, blobHash: hash },
      }, actor));
    }
    return { plan, results };
  }

  async copyPath(
    from: string,
    to: string,
    actor: SyncEvent['actor'],
    nextMetadata: () => { clientSequence: number; idempotencyKey: string },
  ): Promise<OperationResult[]> {
    this.assertWritable();
    const source = await this.revisions.getByPath(from);
    if (!source) throw new CoordinatorError('invalid_request', 'copy source does not exist', { from });
    const snapshot = await this.revisions.load();
    const entries = source.kind === 'directory'
      ? snapshot!.entries
          .filter((entry) => !entry.deleted && (entry.entryId === source.entryId || entry.path.startsWith(`${source.path}/`)))
          .sort((a, b) => {
            const depth = a.path.split('/').length - b.path.split('/').length;
            return depth || (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'directory' ? -1 : 1);
          })
      : [source];
    const results: OperationResult[] = [];
    for (const entry of entries) {
      const suffix = entry.path === source.path ? '' : entry.path.slice(source.path.length + 1);
      const destination = suffix ? `${to}/${suffix}` : to;
      if (entry.kind === 'directory') {
        results.push(await this.apply({
          operation: 'mkdir', ...nextMetadata(), path: destination, kind: 'directory',
        }, actor));
      } else {
        let blob = entry.hash ? await this.blobs.get(entry.hash) : null;
        if (!blob && entry.hash) blob = await this.blobs.putFile(this.absolute(entry.path), entry.hash, entry.size);
        if (!blob || !entry.hash) throw new Error(`copy source blob unavailable for ${entry.path}`);
        results.push(await this.apply({
          operation: 'create', ...nextMetadata(), path: destination, kind: 'file',
          content: { hash: entry.hash, size: entry.size, blobHash: entry.hash },
        }, actor));
      }
    }
    return results;
  }

  async listConflicts(status?: Conflict['status']): Promise<Conflict[]> {
    return this.conflicts.list(status);
  }

  async protectedConflictBlobHashes(): Promise<Set<string>> {
    const hashes = new Set<string>();
    for (const conflict of await this.conflicts.list('unresolved')) {
      if (conflict.currentHash) hashes.add(conflict.currentHash);
      if (conflict.submittedHash) hashes.add(conflict.submittedHash);
      if (conflict.entryId && conflict.baseRevision !== null) {
        const base = await this.bases.get(conflict.entryId, conflict.baseRevision);
        if (base) hashes.add(base.hash);
      }
    }
    return hashes;
  }

  async conflict(conflictId: string): Promise<Conflict | null> {
    return this.conflicts.get(conflictId);
  }

  async resolveConflict(
    conflictId: string,
    resolution: 'keep-server' | 'keep-client' | 'merged' | 'copy',
    actor: SyncEvent['actor'],
    metadata: { clientSequence: number; idempotencyKey: string },
    mergedContent?: Extract<SyncOperation, { operation: 'modify' }>['content'],
  ): Promise<{ conflict: Conflict; result?: OperationResult }> {
    const duplicate = await this.conflicts.resolution(conflictId, metadata.idempotencyKey);
    const conflict = await this.conflicts.get(conflictId);
    if (!conflict) throw new CoordinatorError('invalid_request', 'unknown conflict');
    if (duplicate) return { conflict, ...(duplicate.result ? { result: duplicate.result } : {}) };
    if (conflict.status === 'resolved') throw new CoordinatorError('revision_conflict', 'conflict was already resolved');
    let result: OperationResult | undefined;
    const current = conflict.entryId ? await this.revisions.getById(conflict.entryId) : null;
    if (resolution === 'keep-server' || resolution === 'copy') {
      if (!current || current.deleted || current.kind !== 'file' || !current.hash) {
        throw new CoordinatorError('revision_conflict', 'canonical conflict entry is unavailable', { conflict });
      }
      result = await this.apply({
        operation: 'modify', ...metadata, entryId: current.entryId, baseRevision: current.revision,
        content: { hash: current.hash, size: current.size, blobHash: current.hash },
      }, actor);
    }
    if (resolution === 'merged' || resolution === 'keep-client') {
      if (!current || current.deleted || current.kind !== 'file') {
        throw new CoordinatorError('revision_conflict', 'canonical conflict entry is unavailable', { conflict });
      }
      let content = mergedContent;
      if (resolution === 'keep-client') {
        if (conflict.kind === 'delete') {
          result = await this.apply({
            operation: 'delete', ...metadata, entryId: current.entryId, baseRevision: current.revision,
          }, actor);
        } else {
          const copy = conflict.conflictPath ? await this.revisions.getByPath(conflict.conflictPath) : null;
          if (!copy?.hash || copy.kind !== 'file') throw new CoordinatorError('invalid_request', 'conflict has no client copy');
          content = { hash: copy.hash, size: copy.size, blobHash: copy.hash };
        }
      }
      if (!result) {
        if (!content) throw new CoordinatorError('invalid_request', 'merged content is required');
        result = await this.apply({
          operation: 'modify', ...metadata, entryId: current.entryId, baseRevision: current.revision, content,
        }, actor);
      }
    }
    const resolved = await this.conflicts.resolve(conflictId, metadata.idempotencyKey, resolution, result);
    return { conflict: resolved.conflict, ...(resolved.resolution.result ? { result: resolved.resolution.result } : {}) };
  }

  async listTrash(): Promise<TrashRecord[]> {
    return this.trash.list();
  }

  async purgeTrash(trashPath: string): Promise<void> {
    this.assertWritable();
    const record = await this.trash.findByPath(trashPath);
    if (!record) throw new CoordinatorError('invalid_request', 'trash item does not exist', { trashPath });
    const absoluteTrash = this.absolute(record.trashPath);
    await this.assertNoSymlinkComponents(absoluteTrash);
    await fs.rm(absoluteTrash, { recursive: true, force: true });
    await this.trash.markPurged(record.trashId);
  }

  async emptyTrash(): Promise<void> {
    for (const record of await this.trash.list()) await this.purgeTrash(record.trashPath);
  }

  async restoreTrash(
    trashPath: string,
    actor: SyncEvent['actor'],
    metadata: { clientSequence: number; idempotencyKey: string },
  ): Promise<OperationResult> {
    this.assertWritable();
    const fingerprint = sha256Text(JSON.stringify({ operation: 'restore', trashPath, ...metadata }));
    return this.commitLock.run(async () => {
      const duplicate = await this.idempotency.lookup(actor.id, metadata.clientSequence, metadata.idempotencyKey, fingerprint);
      if (duplicate) return duplicate;
      const record = await this.trash.findByPath(trashPath);
      if (!record) throw new CoordinatorError('invalid_request', 'trash item does not exist', { trashPath });
      return this.pathLocks.withLock([record.originalPath], async () => {
        const tombstone = await this.revisions.getById(record.entryId);
        if (!tombstone?.deleted) throw new CoordinatorError('revision_conflict', 'trash identity is no longer tombstoned', { record });
        const originalFree = !(await this.revisions.getByPath(record.originalPath)) && !(await pathExists(this.absolute(record.originalPath)));
        let targetPath = record.originalPath;
        if (!originalFree) {
          const extension = path.posix.extname(record.originalPath);
          const stem = extension ? record.originalPath.slice(0, -extension.length) : record.originalPath;
          for (let ordinal = 0; ordinal < 10_000; ordinal += 1) {
            const suffix = ordinal ? ` ${ordinal}` : '';
            const candidate = `${stem}.restored-${new Date().toISOString().replace(/[:.]/g, '-')}${suffix}${extension}`;
            if (!(await this.revisions.getByPath(candidate)) && !(await pathExists(this.absolute(candidate)))) {
              targetPath = candidate;
              break;
            }
          }
        }
        const sequence = (await this.vaultState.loadOrCreate()).currentSequence + 1;
        const reuseIdentity = targetPath === record.originalPath;
        const event: SyncEvent = {
          sequence,
          eventId: `event_${randomBytes(18).toString('base64url')}`,
          actor,
          operation: record.kind === 'directory' ? 'mkdir' : 'create',
          entryId: reuseIdentity ? record.entryId : `entry_${randomBytes(18).toString('base64url')}`,
          path: targetPath,
          baseRevision: reuseIdentity ? tombstone.revision : null,
          revision: reuseIdentity ? tombstone.revision + 1 : 1,
          hash: record.hash,
          size: record.size,
          occurredAt: new Date().toISOString(),
        };
        const result: OperationResult = {
          idempotencyKey: metadata.idempotencyKey,
          status: 'accepted', eventId: event.eventId, sequence,
          entryId: event.entryId, revision: event.revision, hash: event.hash, path: event.path,
        };
        const source = this.absolute(record.trashPath);
        await this.assertNoSymlinkComponents(source);
        await this.assertNoSymlinkComponents(this.absolute(targetPath));
        const intent = await this.intents.prepare({
          event, result, clientSequence: metadata.clientSequence, operationFingerprint: fingerprint,
          restoreTrashId: record.trashId,
          targetPath,
          ...(record.kind === 'file' ? { newContentSource: source } : {}),
        });
        try {
          await this.materialize(intent);
          await this.intents.markMaterialized(intent.transactionId);
          await this.journal.append(event);
        } catch (error) {
          if ((await this.journal.latestSequence()) >= event.sequence) {
            await this.finishCommittedOrDegrade(intent);
            return result;
          }
          await this.rollbackUncommittedOrDegrade(intent);
          throw error;
        }
        await this.finishCommittedOrDegrade(intent);
        return result;
      });
    });
  }

  subscribe(subscriber: CommittedEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    this.scheduleDerivedDrain();
    return () => this.subscribers.delete(subscriber);
  }

  async apply(operationInput: SyncOperation, actor: SyncEvent['actor']): Promise<OperationResult> {
    this.assertWritable();
    const operation = SyncOperationSchema.parse(operationInput);
    const fingerprint = operationFingerprint(operation);
    const started = performance.now();
    try {
      const result = await this.commitLock.run(async () => {
      try {
        const duplicate = await this.idempotency.lookup(actor.id, operation.clientSequence, operation.idempotencyKey, fingerprint);
        if (duplicate) {
          this.operationMetrics.deduplicated += 1;
          return duplicate;
        }
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          throw new CoordinatorError('client_sequence_reused', error.message, error.details);
        }
        throw error;
      }
      const current = 'entryId' in operation ? await this.revisions.getById(operation.entryId) : null;
      const requestedPath = 'path' in operation ? operation.path : current?.path;
      if (!requestedPath) throw new CoordinatorError('revision_conflict', 'entry no longer exists');
      const lockPaths = [requestedPath, ...(current && current.path !== requestedPath ? [current.path] : [])];
        return this.pathLocks.withLock(lockPaths, () => this.applyLocked(operation, actor, current, fingerprint));
      });
      this.operationMetrics[result.status === 'dependency_failed' ? 'dependencyFailed' : result.status] += 1;
      this.recordOperationLatency(performance.now() - started);
      return result;
    } catch (error) {
      this.operationMetrics.rejected += 1;
      this.recordOperationLatency(performance.now() - started);
      throw error;
    }
  }

  private recordOperationLatency(durationMs: number): void {
    this.operationLatencyCount += 1;
    this.operationLatencyTotalMs += durationMs;
    this.operationLatencyMaxMs = Math.max(this.operationLatencyMaxMs, durationMs);
  }

  private async applyLocked(
    operation: SyncOperation,
    actor: SyncEvent['actor'],
    initialCurrent: SyncEntry | null,
    fingerprint: string,
    resultStatus: 'accepted' | 'merged' | 'conflict' = 'accepted',
    conflict?: Conflict,
  ): Promise<OperationResult> {
    const current = 'entryId' in operation ? await this.revisions.getById(operation.entryId) : null;
    if ('entryId' in operation && (operation.operation === 'delete' || operation.operation === 'rmdir') && current?.deleted) {
      const result: OperationResult = {
        idempotencyKey: operation.idempotencyKey,
        status: 'accepted',
        sequence: current.sequence,
        entryId: current.entryId,
        revision: current.revision,
        hash: null,
        path: current.path,
      };
      await this.idempotency.record(actor.id, operation.clientSequence, operation.idempotencyKey, fingerprint, result);
      return result;
    }
    if ('entryId' in operation && current?.revision !== operation.baseRevision) {
      if (operation.operation === 'modify') return this.applyStaleTextModify(operation, actor, current, fingerprint);
      if (operation.operation === 'delete' && current && !current.deleted) {
        return this.recordMetadataConflict(operation, actor, current, fingerprint, 'delete');
      }
      if (operation.operation === 'rename' && current && !current.deleted) {
        if (current.path === operation.path) {
          const result: OperationResult = {
            idempotencyKey: operation.idempotencyKey,
            status: 'accepted',
            sequence: current.sequence,
            entryId: current.entryId,
            revision: current.revision,
            hash: current.hash,
            path: current.path,
          };
          await this.idempotency.record(actor.id, operation.clientSequence, operation.idempotencyKey, fingerprint, result);
          return result;
        }
        const intervening = (await this.journal.replay()).filter(
          (event) => event.entryId === current.entryId && event.revision > operation.baseRevision,
        );
        if (intervening.length > 0 && intervening.every((event) => event.operation === 'modify')) {
          return this.applyLocked({ ...operation, baseRevision: current.revision }, actor, current, fingerprint);
        }
        return this.recordMetadataConflict(operation, actor, current, fingerprint, 'rename');
      }
      if (operation.operation === 'rename' && current?.deleted) {
        return this.recordMetadataConflict(operation, actor, current, fingerprint, 'rename');
      }
    }
    if ('entryId' in operation) this.validateCurrent(operation, current, initialCurrent);
    const requestedPath = 'path' in operation ? operation.path : current!.path;
    const destination = await this.revisions.getByPath(requestedPath);
    if (operation.operation === 'create' || operation.operation === 'mkdir') {
      if (destination) {
        const converged = operation.operation === 'mkdir'
          ? destination.kind === 'directory'
          : destination.kind === 'file'
            && destination.hash === operation.content.hash
            && destination.size === operation.content.size;
        if (converged) {
          const result: OperationResult = {
            idempotencyKey: operation.idempotencyKey,
            status: 'accepted',
            sequence: destination.sequence,
            entryId: destination.entryId,
            revision: destination.revision,
            hash: destination.hash,
            path: destination.path,
          };
          await this.idempotency.record(actor.id, operation.clientSequence, operation.idempotencyKey, fingerprint, result);
          return result;
        }
        throw this.pathCollision(requestedPath, destination);
      }
    } else if (operation.operation === 'rename' && destination && destination.entryId !== operation.entryId) {
      throw this.pathCollision(requestedPath, destination);
    }
    if (operation.operation === 'rmdir') {
      const prefix = `${current!.path}/`;
      const snapshot = await this.revisions.load();
      if (snapshot!.entries.some((entry) => !entry.deleted && entry.path.startsWith(prefix))) {
        throw new CoordinatorError('revision_conflict', 'directory is not empty', { entryId: current!.entryId, path: current!.path });
      }
    }

    const sequence = (await this.vaultState.loadOrCreate()).currentSequence + 1;
    const source = await this.resolveOperationContent(operation);
    try {
      const event = await this.buildEvent(operation, actor, current, sequence, source);
      const result: OperationResult = {
        idempotencyKey: operation.idempotencyKey,
        status: resultStatus,
        eventId: event.eventId,
        sequence: event.sequence,
        entryId: event.entryId,
        revision: event.revision,
        hash: event.hash,
        path: event.path,
        ...(conflict ? { conflictId: conflict.conflictId } : {}),
      };
      const previousSource = current?.kind === 'file' && ['modify', 'delete'].includes(operation.operation)
        ? this.absolute(current.path)
        : undefined;
      const intent = await this.intents.prepare({
        event,
        result,
        clientSequence: operation.clientSequence,
        operationFingerprint: fingerprint,
        ...(conflict ? { conflict } : {}),
        targetPath: event.path,
        ...(current ? { previousPath: current.path } : {}),
        ...(source ? { newContentSource: source } : {}),
        ...(previousSource ? { previousContentSource: previousSource } : {}),
      });
      try {
        await this.inject('after_intent');
        await this.materialize(intent);
        await this.inject('after_materialize');
        await this.intents.markMaterialized(intent.transactionId);
        await this.inject('after_materialized_marker');
        await this.journal.append(event); // commit point
        await this.inject('after_journal_commit');
      } catch (error) {
        if (error instanceof SimulatedProcessCrash) throw error;
        if ((await this.journal.latestSequence()) >= event.sequence) {
          await this.finishCommittedOrDegrade(intent);
          return result;
        }
        await this.rollbackUncommittedOrDegrade(intent);
        throw error;
      }
      await this.finishCommittedOrDegrade(intent);
      return result;
    } finally {
      if (source?.startsWith(path.join(this.options.dataDir, 'sync', 'uploads', 'inline-'))) {
        await fs.rm(source, { force: true });
      }
    }
  }

  private async applyStaleTextModify(
    operation: Extract<SyncOperation, { operation: 'modify' }>,
    actor: SyncEvent['actor'],
    current: SyncEntry | null,
    fingerprint: string,
  ): Promise<OperationResult> {
    if (!current || current.kind !== 'file') this.validateCurrent(operation, current, current);
    if (!current!.deleted && current!.hash === operation.content.hash && current!.size === operation.content.size) {
      const result: OperationResult = {
        idempotencyKey: operation.idempotencyKey,
        status: 'accepted',
        sequence: current!.sequence,
        entryId: current!.entryId,
        revision: current!.revision,
        hash: current!.hash,
        path: current!.path,
      };
      await this.idempotency.record(actor.id, operation.clientSequence, operation.idempotencyKey, fingerprint, result);
      return result;
    }
    const source = await this.resolveOperationContent(operation);
    if (!source) throw new CoordinatorError('invalid_request', 'modify content is missing');
    try {
      await this.blobs.putFile(source, operation.content.hash, operation.content.size);
      if (current!.deleted) {
        return this.commitConflictCopy(operation, actor, current!, source, fingerprint, 'revision');
      }
      if (!/\.(md|markdown|txt|json|csv|canvas|css|js|ya?ml)$/i.test(current!.path)) {
        return this.commitConflictCopy(operation, actor, current!, source, fingerprint, 'binary');
      }
      const [base, currentStat, submittedStat] = await Promise.all([
        this.bases.get(operation.entryId, operation.baseRevision),
        fs.stat(this.absolute(current!.path)),
        fs.stat(source),
      ]);
      if (!base || currentStat.size > MAX_AUTO_MERGE_BYTES || submittedStat.size > MAX_AUTO_MERGE_BYTES) {
        return this.commitConflictCopy(operation, actor, current!, source, fingerprint, 'revision');
      }
      let baseText: string;
      let currentText: string;
      let submittedText: string;
      try {
        [baseText, currentText, submittedText] = await Promise.all([
          fs.readFile(base.file).then(decodeUtf8),
          fs.readFile(this.absolute(current!.path)).then(decodeUtf8),
          fs.readFile(source).then(decodeUtf8),
        ]);
      } catch {
        return this.commitConflictCopy(operation, actor, current!, source, fingerprint, 'binary');
      }
      const merged = mergeText(currentText, baseText, submittedText);
      if (!merged.clean) return this.commitConflictCopy(operation, actor, current!, source, fingerprint, 'revision');
      const bytes = Buffer.from(merged.content, 'utf8');
      const hash = sha256Text(merged.content);
      await this.blobs.put([bytes], hash, bytes.byteLength);
      const rebased: SyncOperation = {
        ...operation,
        baseRevision: current!.revision,
        content: { hash, size: bytes.byteLength, blobHash: hash },
      };
      return this.applyLocked(rebased, actor, current, fingerprint, 'merged');
    } finally {
      if (source.startsWith(path.join(this.options.dataDir, 'sync', 'uploads', 'inline-'))) await fs.rm(source, { force: true });
    }
  }

  private async commitConflictCopy(
    operation: Extract<SyncOperation, { operation: 'modify' }>,
    actor: SyncEvent['actor'],
    current: SyncEntry,
    source: string,
    fingerprint: string,
    kind: 'revision' | 'binary',
  ): Promise<OperationResult> {
    const createdAt = new Date();
    let conflictPath = '';
    for (let ordinal = 0; ordinal < 10_000; ordinal += 1) {
      const candidate = conflictCopyPath(current.path, actor.id, createdAt, ordinal);
      if (!(await this.revisions.getByPath(candidate)) && !(await pathExists(this.absolute(candidate)))) {
        conflictPath = candidate;
        break;
      }
    }
    if (!conflictPath) throw new CoordinatorError('path_collision', 'unable to allocate a unique conflict-copy path');
    const conflict: Conflict = {
      conflictId: `conflict_${randomBytes(18).toString('base64url')}`,
      entryId: current.entryId,
      path: current.path,
      kind,
      actor,
      baseRevision: operation.baseRevision,
      currentRevision: current.revision,
      submittedHash: operation.content.hash,
      ...(current.hash ? { currentHash: current.hash } : {}),
      conflictPath,
      status: 'unresolved',
      createdAt: createdAt.toISOString(),
    };
    const copyOperation: SyncOperation = {
      operation: 'create',
      clientSequence: operation.clientSequence,
      idempotencyKey: operation.idempotencyKey,
      path: conflictPath,
      kind: 'file',
      content: {
        hash: operation.content.hash,
        size: operation.content.size,
        blobHash: operation.content.hash,
      },
    };
    return this.applyLocked(copyOperation, actor, null, fingerprint, 'conflict', conflict);
  }

  private async recordMetadataConflict(
    operation: Extract<SyncOperation, { entryId: string }>,
    actor: SyncEvent['actor'],
    current: SyncEntry,
    fingerprint: string,
    kind: 'delete' | 'rename',
  ): Promise<OperationResult> {
    const conflictId = `conflict_${sha256Text(`${actor.id}\0${operation.idempotencyKey}\0${fingerprint}`).slice(0, 32)}`;
    const conflict: Conflict = {
      conflictId,
      entryId: current.entryId,
      path: current.path,
      kind,
      actor,
      baseRevision: operation.baseRevision,
      currentRevision: current.revision,
      ...(current.hash ? { currentHash: current.hash } : {}),
      status: 'unresolved',
      createdAt: current.modifiedAt,
    };
    await this.conflicts.upsert(conflict);
    const result: OperationResult = {
      idempotencyKey: operation.idempotencyKey,
      status: 'conflict',
      sequence: current.sequence,
      entryId: current.entryId,
      revision: current.revision,
      hash: current.hash,
      path: current.path,
      conflictId,
    };
    await this.idempotency.record(actor.id, operation.clientSequence, operation.idempotencyKey, fingerprint, result);
    return result;
  }

  private validateCurrent(
    operation: Extract<SyncOperation, { entryId: string }>,
    current: SyncEntry | null,
    initialCurrent: SyncEntry | null,
  ): void {
    if (!current || current.deleted || current.entryId !== operation.entryId) {
      throw new CoordinatorError('revision_conflict', 'entry no longer exists', {
        entryId: operation.entryId,
        baseRevision: operation.baseRevision,
        current: current ?? null,
        submitted: submittedReference(operation),
      });
    }
    if (current.revision !== operation.baseRevision) {
      throw new CoordinatorError('revision_conflict', 'base revision is stale', {
        entryId: operation.entryId,
        baseRevision: operation.baseRevision,
        current,
        submitted: submittedReference(operation),
      });
    }
    if (initialCurrent && initialCurrent.path !== current.path) {
      throw new CoordinatorError('revision_conflict', 'entry moved while waiting for lock', { current });
    }
    if (operation.operation === 'rmdir' && current.kind !== 'directory') {
      throw new CoordinatorError('invalid_request', 'rmdir requires a directory');
    }
    if (['modify', 'delete'].includes(operation.operation) && current.kind !== 'file') {
      throw new CoordinatorError('invalid_request', `${operation.operation} requires a file`);
    }
  }

  private async buildEvent(
    operation: SyncOperation,
    actor: SyncEvent['actor'],
    current: SyncEntry | null,
    sequence: number,
    source: string | null,
  ): Promise<SyncEvent> {
    let hash: string | null = current?.hash ?? null;
    let size = current?.size ?? 0;
    if (source) {
      const stat = await fs.stat(source);
      hash = await sha256Chunks(createReadStream(source));
      size = stat.size;
      if ('content' in operation && (hash !== operation.content.hash || size !== operation.content.size)) {
        throw new CoordinatorError('hash_mismatch', 'submitted content hash or size does not match bytes', {
          submittedHash: operation.content.hash, actualHash: hash,
          submittedSize: operation.content.size, actualSize: size,
        });
      }
    }
    if (operation.operation === 'delete' || operation.operation === 'rmdir') {
      hash = null;
      size = 0;
    }
    return {
      sequence,
      eventId: `event_${randomBytes(18).toString('base64url')}`,
      actor,
      operation: operation.operation,
      entryId: current?.entryId ?? `entry_${randomBytes(18).toString('base64url')}`,
      path: 'path' in operation ? operation.path : current!.path,
      ...(operation.operation === 'rename' ? { oldPath: current!.path } : {}),
      baseRevision: current?.revision ?? null,
      revision: (current?.revision ?? 0) + 1,
      hash,
      ...(current?.hash ? { previousHash: current.hash } : {}),
      size,
      occurredAt: new Date().toISOString(),
    };
  }

  private async resolveOperationContent(operation: SyncOperation): Promise<string | null> {
    if (!('content' in operation)) return null;
    if (operation.content.inlineText !== undefined) {
      const paths = path.join(this.options.dataDir, 'sync', 'uploads');
      await fs.mkdir(paths, { recursive: true, mode: 0o700 });
      const file = path.join(paths, `inline-${randomBytes(12).toString('hex')}`);
      await fs.writeFile(file, operation.content.inlineText, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const handle = await fs.open(file, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      return file;
    }
    if (this.options.resolveBlob) return this.options.resolveBlob(operation.content.blobHash!);
    const blob = await this.blobs.get(operation.content.blobHash!);
    if (!blob) throw new CoordinatorError('invalid_request', 'referenced blob does not exist');
    return blob.file;
  }

  private async materialize(intent: TransactionIntent): Promise<void> {
    const event = intent.event;
    const target = this.absolute(intent.targetPath);
    const previous = intent.previousPath ? this.absolute(intent.previousPath) : null;
    await this.assertNoSymlinkComponents(target);
    if (previous) await this.assertNoSymlinkComponents(previous);
    switch (event.operation) {
      case 'create':
        await assertAbsent(target);
        await this.atomicInstall(this.intents.contentPath(intent, 'new')!, target);
        break;
      case 'modify':
        await this.assertHash(target, event.previousHash!);
        await this.atomicInstall(this.intents.contentPath(intent, 'new')!, target);
        break;
      case 'mkdir':
        await fs.mkdir(target, { recursive: false, mode: 0o755 });
        await fsyncDirectory(path.dirname(target));
        break;
      case 'rename': {
        const caseOnly = previous!.toLocaleLowerCase('en-US') === target.toLocaleLowerCase('en-US') && previous !== target;
        if (caseOnly) {
          const temporary = this.caseRenameTemporary(intent);
          await assertAbsent(temporary);
          await fs.rename(previous!, temporary);
          await fsyncDirectory(path.dirname(previous!));
          await fs.rename(temporary, target);
        } else {
          await assertAbsent(target);
          await fs.rename(previous!, target);
        }
        await fsyncDirectory(path.dirname(previous!));
        if (path.dirname(previous!) !== path.dirname(target)) await fsyncDirectory(path.dirname(target));
        break;
      }
      case 'delete':
      case 'rmdir': {
        const trash = this.trashPath(intent);
        await this.assertNoSymlinkComponents(trash);
        await fs.mkdir(path.dirname(trash), { recursive: true, mode: 0o700 });
        await fs.rename(previous!, trash);
        await fsyncDirectory(path.dirname(previous!));
        await fsyncDirectory(path.dirname(trash));
        break;
      }
    }
  }

  private async rollback(intent: TransactionIntent): Promise<void> {
    const event = intent.event;
    const target = this.absolute(intent.targetPath);
    const previous = intent.previousPath ? this.absolute(intent.previousPath) : null;
    await this.assertNoSymlinkComponents(target);
    if (previous) await this.assertNoSymlinkComponents(previous);
    if (event.operation === 'delete' || event.operation === 'rmdir') await this.assertNoSymlinkComponents(this.trashPath(intent));
    if (event.operation === 'create') {
      if (await pathExists(target)) await fs.rm(target, { force: true });
    } else if (event.operation === 'modify') {
      const old = this.intents.contentPath(intent, 'previous');
      if (old) await this.atomicInstall(old, target);
    } else if (event.operation === 'mkdir') {
      if (await pathExists(target)) await fs.rmdir(target).catch(() => undefined);
    } else if (event.operation === 'rename') {
      const temporary = this.caseRenameTemporary(intent);
      if (previous && !(await pathExists(previous)) && await pathExists(temporary)) await fs.rename(temporary, previous);
      else if (await pathExists(target) && previous && !(await pathExists(previous))) await fs.rename(target, previous);
    } else {
      const trash = this.trashPath(intent);
      if (previous && !(await pathExists(previous))) {
        if (await pathExists(trash)) await fs.rename(trash, previous);
        else if (intent.previousContent) await this.atomicInstall(this.intents.contentPath(intent, 'previous')!, previous);
        else if (event.operation === 'rmdir') await fs.mkdir(previous);
      }
    }
  }

  private async rollbackUncommittedOrDegrade(intent: TransactionIntent): Promise<void> {
    try {
      await this.rollback(intent);
      await this.intents.remove(intent.transactionId);
    } catch (error) {
      this.degradedReason = `pre-commit rollback failed for ${intent.transactionId}: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    }
  }

  private async finishCommittedOrDegrade(intent: TransactionIntent): Promise<void> {
    try {
      await this.finishCommitted(intent);
    } catch (error) {
      this.degradedReason = `post-commit recovery failed at sequence ${intent.event.sequence}: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    }
  }

  private async finishCommitted(intent: TransactionIntent): Promise<void> {
    this.registerWatcherSuppression(intent.event);
    if (await this.revisions.currentSequence() < intent.event.sequence) await this.revisions.applyCommittedEvent(intent.event);
    await this.inject('after_revision_snapshot');
    await this.vaultState.setCurrentSequence(intent.event.sequence);
    if (intent.newContent && intent.event.hash) {
      await this.blobs.putFile(
        this.intents.contentPath(intent, 'new')!,
        intent.event.hash,
        intent.event.size,
      );
    }
    if (intent.event.previousHash && intent.event.baseRevision !== null) {
      const previousFile = intent.previousContent
        ? this.intents.contentPath(intent, 'previous')!
        : (await this.blobs.get(intent.event.previousHash))?.file;
      if (previousFile) {
        await this.bases.retainFile({
          entryId: intent.event.entryId,
          revision: intent.event.baseRevision,
          hash: intent.event.previousHash,
          size: intent.previousContent?.size ?? intent.event.size,
          eventSequence: intent.event.sequence,
        }, previousFile);
      }
    }
    if (intent.conflict) await this.conflicts.upsert(intent.conflict);
    if (intent.restoreTrashId) {
      const record = await this.trash.get(intent.restoreTrashId);
      if (!record) throw new Error(`restore references unknown trash record ${intent.restoreTrashId}`);
      const absoluteTrash = this.absolute(record.trashPath);
      await this.assertNoSymlinkComponents(absoluteTrash);
      await fs.rm(absoluteTrash, { recursive: true, force: true });
      await this.trash.markRestored(record.trashId, intent.event.path, new Date(intent.event.occurredAt));
    }
    if (intent.event.operation === 'delete' || intent.event.operation === 'rmdir') {
      await this.trash.upsert({
        trashId: `trash_${intent.transactionId.slice(3)}`,
        transactionId: intent.transactionId,
        entryId: intent.event.entryId,
        kind: intent.event.operation === 'rmdir' ? 'directory' : 'file',
        originalPath: intent.event.path,
        trashPath: this.trashRelativePath(intent),
        deletedRevision: intent.event.revision,
        hash: intent.event.previousHash ?? null,
        size: intent.previousContent?.size ?? 0,
        status: 'trashed',
        deletedAt: intent.event.occurredAt,
      });
    }
    await this.idempotency.rebuildRecord(
      intent.event.actor.id,
      intent.clientSequence,
      intent.result.idempotencyKey,
      intent.operationFingerprint,
      intent.result,
    );
    await this.inject('after_idempotency_snapshot');
    this.latestSequence = Math.max(this.latestSequence, intent.event.sequence);
    await this.derivedQueue.enqueue(intent.event);
    this.scheduleDerivedDrain();
    await this.intents.remove(intent.transactionId);
  }

  private async recoverIntents(): Promise<void> {
    const committedEvents = await this.journal.replay();
    const committed = new Set(committedEvents.map((event) => event.eventId));
    for (const intent of await this.intents.list()) {
      if (committed.has(intent.event.eventId)) {
        if (!(await this.isMaterialized(intent))) throw new Error(`committed transaction ${intent.transactionId} diverges from vault`);
        await this.finishCommitted(intent);
      } else if (await this.isMaterialized(intent)) {
        const latest = await this.journal.latestSequence();
        if (intent.event.sequence !== latest + 1) throw new Error(`recoverable transaction ${intent.transactionId} has invalid sequence`);
        await this.journal.append(intent.event);
        await this.finishCommitted(intent);
      } else {
        await this.rollback(intent);
        await this.intents.remove(intent.transactionId);
      }
    }
  }

  private async isMaterialized(intent: TransactionIntent): Promise<boolean> {
    const target = this.absolute(intent.targetPath);
    switch (intent.event.operation) {
      case 'create':
      case 'modify':
        return (await hashIfFile(target)) === intent.event.hash;
      case 'mkdir':
        return (await kindIfExists(target)) === 'directory';
      case 'rename':
        return (await pathExists(target)) && !intent.previousPath
          ? true
          : (await pathExists(target)) && !(await pathExists(this.absolute(intent.previousPath!)));
      case 'delete':
      case 'rmdir':
        return !(await pathExists(this.absolute(intent.previousPath!)));
    }
  }

  private async ensureCurrentBlobs(): Promise<void> {
    const snapshot = await this.revisions.load();
    for (const entry of snapshot?.entries ?? []) {
      if (entry.deleted || entry.kind !== 'file' || !entry.hash || await this.blobs.get(entry.hash)) continue;
      try {
        await this.blobs.putFile(this.absolute(entry.path), entry.hash, entry.size);
      } catch (error) {
        // The file may have changed while the server was offline. Drift reconciliation
        // below records that change; never bless mismatching bytes as the old revision.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && !(error instanceof Error && /hash mismatch|size mismatch/.test(error.message))) throw error;
      }
    }
  }

  private async validateAndReplay(): Promise<void> {
    const snapshot = await this.revisions.load();
    const latest = await this.journal.latestSequence();
    if (snapshot!.currentSequence > latest) throw new Error('revision snapshot is ahead of committed journal');
    for (const event of await this.journal.replay(snapshot!.currentSequence)) await this.revisions.applyCommittedEvent(event);
    const state = await this.vaultState.loadOrCreate();
    if (state.currentSequence > latest) throw new Error('vault sequence is ahead of committed journal');
    if (state.currentSequence < latest) await this.vaultState.setCurrentSequence(latest);
  }

  private async atomicInstall(source: string, destination: string): Promise<void> {
    const temporary = path.join(path.dirname(destination), `.sync-${randomBytes(12).toString('hex')}.tmp`);
    await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    const handle = await fs.open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, destination);
    await fsyncDirectory(path.dirname(destination));
  }

  private async assertNoSymlinkComponents(absolutePath: string): Promise<void> {
    const relative = path.relative(this.root, absolutePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      if (absolutePath === this.root) return;
      throw new CoordinatorError('invalid_request', 'path escapes vault');
    }
    let current = this.root;
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new CoordinatorError('invalid_request', 'symbolic links are not valid sync paths');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  }

  private async assertHash(file: string, expected: string): Promise<void> {
    const actual = await hashIfFile(file);
    if (actual !== expected) throw new CoordinatorError('revision_conflict', 'vault bytes changed outside coordinator', { expected, actual });
  }

  private absolute(relative: string): string {
    const result = path.resolve(this.root, ...relative.split('/'));
    if (!result.startsWith(`${this.root}${path.sep}`)) throw new CoordinatorError('invalid_request', 'path escapes vault');
    return result;
  }

  private caseRenameTemporary(intent: TransactionIntent): string {
    const previous = this.absolute(intent.previousPath!);
    return path.join(path.dirname(previous), `.sync-case-${intent.transactionId}`);
  }

  private trashRelativePath(intent: TransactionIntent): string {
    return `.trash/sync/${intent.transactionId}/${path.basename(intent.previousPath!)}`;
  }

  private trashPath(intent: TransactionIntent): string {
    return this.absolute(this.trashRelativePath(intent));
  }

  private scheduleDerivedDrain(): void {
    if (!this.subscribers.size) return;
    void this.derivedQueue.process(async (event) => {
      for (const subscriber of this.subscribers) await subscriber(event);
    }).catch(() => {
      if (this.derivedRetryTimer) return;
      const attempts = this.derivedQueue.status().failedAttempts;
      const delay = Math.min(60_000, 250 * 2 ** Math.min(attempts, 8));
      this.derivedRetryTimer = setTimeout(() => {
        this.derivedRetryTimer = null;
        this.scheduleDerivedDrain();
      }, delay);
      this.derivedRetryTimer.unref();
    });
  }

  private nextExternalOperationMetadata(): { clientSequence: number; idempotencyKey: string } {
    const clientSequence = ++this.externalClientSequence;
    return {
      clientSequence,
      idempotencyKey: `server-fs:${clientSequence}:${randomBytes(12).toString('base64url')}`,
    };
  }

  private consumeWatcherSuppression(relativePath: string, exists: boolean, hash: string | null): boolean {
    const key = relativePath.toLocaleLowerCase('en-US');
    const marker = this.watcherSuppressions.get(key);
    if (!marker) return false;
    if (marker.expiresAt < Date.now()) {
      this.watcherSuppressions.delete(key);
      return false;
    }
    if (marker.exists === exists && marker.hash === hash) {
      this.watcherSuppressions.delete(key);
      return true;
    }
    return false;
  }

  private registerWatcherSuppression(event: SyncEvent): void {
    const expiresAt = Date.now() + 10_000;
    const deleted = event.operation === 'delete' || event.operation === 'rmdir';
    this.watcherSuppressions.set(event.path.toLocaleLowerCase('en-US'), {
      exists: !deleted,
      hash: deleted || event.operation === 'mkdir' ? null : event.hash,
      expiresAt,
    });
    if (event.oldPath) {
      this.watcherSuppressions.set(event.oldPath.toLocaleLowerCase('en-US'), { exists: false, hash: null, expiresAt });
    }
  }

  private async materializeExternalTrash(intent: TransactionIntent, previousBlob: string | null): Promise<void> {
    const trash = this.trashPath(intent);
    await fs.mkdir(path.dirname(trash), { recursive: true, mode: 0o700 });
    if (intent.event.operation === 'rmdir') await fs.mkdir(trash, { mode: 0o700 });
    else {
      if (!previousBlob) throw new Error(`external delete has no retained bytes for ${intent.event.path}`);
      await this.atomicInstall(previousBlob, trash);
    }
    await fsyncDirectory(path.dirname(trash));
  }

  private async inject(point: CoordinatorCrashPoint): Promise<void> {
    await this.options.faultInjector?.(point);
  }

  private pathCollision(pathValue: string, existing: SyncEntry): CoordinatorError {
    return new CoordinatorError('path_collision', 'destination path already exists', { path: pathValue, current: existing });
  }

  private assertWritable(): void {
    if (!this.initialized) throw new Error('sync coordinator is not initialized');
    if (this.degradedReason) throw new CoordinatorError('sync_read_only', 'sync storage is in read-only degraded mode', { reason: this.degradedReason });
  }
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

function operationFingerprint(operation: SyncOperation): string {
  const content = 'content' in operation
    ? { hash: operation.content.hash, size: operation.content.size, source: operation.content.blobHash ? 'blob' : 'inline' }
    : undefined;
  return sha256Text(JSON.stringify({
    operation: operation.operation,
    clientSequence: operation.clientSequence,
    idempotencyKey: operation.idempotencyKey,
    ...('entryId' in operation ? { entryId: operation.entryId, baseRevision: operation.baseRevision } : {}),
    ...('path' in operation ? { path: operation.path } : {}),
    ...(content ? { content } : {}),
  }));
}

function submittedReference(operation: Extract<SyncOperation, { entryId: string }>): Record<string, unknown> {
  return {
    operation: operation.operation,
    entryId: operation.entryId,
    baseRevision: operation.baseRevision,
    ...('path' in operation ? { path: operation.path } : {}),
    ...('content' in operation ? { hash: operation.content.hash, size: operation.content.size } : {}),
  };
}

async function assertAbsent(target: string): Promise<void> {
  if (await pathExists(target)) throw new CoordinatorError('path_collision', 'destination exists on disk', { path: target });
}

async function pathExists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function kindIfExists(target: string): Promise<'file' | 'directory' | null> {
  try {
    const stat = await fs.lstat(target);
    return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function hashIfFile(target: string): Promise<string | null> {
  if ((await kindIfExists(target)) !== 'file') return null;
  return sha256Chunks(createReadStream(target));
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    await handle?.close();
  }
}

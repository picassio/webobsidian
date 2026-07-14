import { z } from 'zod';

export const PROTOCOL_VERSION = '1.0' as const;
export const DEFAULT_LIMITS = {
  inlineTextBytes: 1_048_576,
  blobChunkBytes: 8_388_608,
  maxOperationsPerBatch: 100,
  requestsPerMinute: 600,
  manifestPageSize: 1_000,
  manifestTtlSec: 900,
  uploadTtlSec: 86_400,
} as const;

export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);
export const SafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PositiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const IsoDateSchema = z.string().datetime({ offset: true });
export const IdSchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const VaultPathSchema = z.string().min(1).max(4096).refine(
  (value) => {
    if (value !== value.normalize('NFC')) return false;
    if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
    const segments = value.split('/');
    return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  },
  'must be a normalized vault-relative POSIX path',
);

export const ActorSchema = z.object({
  type: z.enum(['device', 'web', 'agent', 'server-fs', 'git-import', 'legacy']),
  id: z.string().min(1).max(256),
}).strict();

export const SyncEntrySchema = z.object({
  entryId: IdSchema,
  path: VaultPathSchema,
  kind: z.enum(['file', 'directory']),
  revision: SafeIntegerSchema,
  hash: Sha256Schema.nullable(),
  size: SafeIntegerSchema,
  modifiedAt: IsoDateSchema,
  deleted: z.boolean(),
  sequence: SafeIntegerSchema,
}).strict().superRefine((entry, ctx) => {
  if (entry.kind === 'directory' && entry.hash !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hash'], message: 'directory hash must be null' });
  }
  if (entry.deleted && entry.hash !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hash'], message: 'tombstone hash must be null' });
  }
});

export const SyncOperationKindSchema = z.enum(['create', 'modify', 'rename', 'delete', 'mkdir', 'rmdir']);

export const SyncEventSchema = z.object({
  sequence: SafeIntegerSchema,
  eventId: IdSchema,
  actor: ActorSchema,
  operation: SyncOperationKindSchema,
  entryId: IdSchema,
  path: VaultPathSchema,
  oldPath: VaultPathSchema.optional(),
  baseRevision: SafeIntegerSchema.nullable(),
  revision: SafeIntegerSchema,
  hash: Sha256Schema.nullable(),
  previousHash: Sha256Schema.optional(),
  size: SafeIntegerSchema,
  occurredAt: IsoDateSchema,
}).strict().superRefine((event, ctx) => {
  if (event.operation === 'rename' && !event.oldPath) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['oldPath'], message: 'rename requires oldPath' });
  }
  if (event.operation !== 'rename' && event.oldPath) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['oldPath'], message: 'oldPath is rename-only' });
  }
  if ((event.operation === 'delete' || event.operation === 'rmdir') && (event.hash !== null || event.size !== 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hash'], message: 'deletion hash must be null' });
  }
});

const OperationBaseSchema = z.object({
  clientSequence: PositiveSafeIntegerSchema,
  idempotencyKey: z.string().min(16).max(256),
  dependsOn: z.array(z.string().min(16).max(256)).max(100).optional(),
});

const ExistingOperationBaseSchema = OperationBaseSchema.extend({
  entryId: IdSchema,
  baseRevision: SafeIntegerSchema,
});

const ContentReferenceSchema = z.object({
  hash: Sha256Schema,
  size: SafeIntegerSchema,
  inlineText: z.string().max(DEFAULT_LIMITS.inlineTextBytes).optional(),
  blobHash: Sha256Schema.optional(),
}).strict().superRefine((value, ctx) => {
  const hasInline = value.inlineText !== undefined;
  const hasBlob = value.blobHash !== undefined;
  if (Number(hasInline) + Number(hasBlob) !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'exactly one of inlineText/blobHash is required' });
  }
  if (hasInline && new TextEncoder().encode(value.inlineText).byteLength > DEFAULT_LIMITS.inlineTextBytes) {
    ctx.addIssue({ code: z.ZodIssueCode.too_big, maximum: DEFAULT_LIMITS.inlineTextBytes, inclusive: true, type: 'string', message: 'inlineText exceeds UTF-8 byte limit' });
  }
});

export const CreateOperationSchema = OperationBaseSchema.extend({
  operation: z.literal('create'),
  path: VaultPathSchema,
  kind: z.literal('file'),
  content: ContentReferenceSchema,
}).strict();

export const MkdirOperationSchema = OperationBaseSchema.extend({
  operation: z.literal('mkdir'),
  path: VaultPathSchema,
  kind: z.literal('directory'),
}).strict();

export const ModifyOperationSchema = ExistingOperationBaseSchema.extend({
  operation: z.literal('modify'),
  content: ContentReferenceSchema,
}).strict();

export const RenameOperationSchema = ExistingOperationBaseSchema.extend({
  operation: z.literal('rename'),
  path: VaultPathSchema,
}).strict();

export const DeleteOperationSchema = ExistingOperationBaseSchema.extend({
  operation: z.literal('delete'),
}).strict();

export const RmdirOperationSchema = ExistingOperationBaseSchema.extend({
  operation: z.literal('rmdir'),
}).strict();

export const SyncOperationSchema = z.discriminatedUnion('operation', [
  CreateOperationSchema,
  MkdirOperationSchema,
  ModifyOperationSchema,
  RenameOperationSchema,
  DeleteOperationSchema,
  RmdirOperationSchema,
]);

export const OperationResultSchema = z.object({
  idempotencyKey: z.string().min(16).max(256),
  status: z.enum(['accepted', 'merged', 'conflict', 'rejected', 'dependency_failed']),
  eventId: IdSchema.optional(),
  sequence: SafeIntegerSchema.optional(),
  entryId: IdSchema.optional(),
  revision: SafeIntegerSchema.optional(),
  hash: Sha256Schema.nullable().optional(),
  path: VaultPathSchema.optional(),
  conflictId: IdSchema.optional(),
  errorCode: z.string().optional(),
}).strict();

export const ErrorCodeSchema = z.enum([
  'invalid_request',
  'invalid_path',
  'hash_mismatch',
  'authentication_required',
  'token_invalid',
  'scope_denied',
  'device_revoked',
  'insecure_transport',
  'revision_conflict',
  'path_collision',
  'client_sequence_reused',
  'cursor_expired',
  'manifest_expired',
  'client_upgrade_required',
  'revision_expired',
  'payload_too_large',
  'quota_exceeded',
  'dependency_failed',
  'protocol_incompatible',
  'rate_limited',
  'sync_read_only',
  'temporarily_unavailable',
]);

export const ErrorEnvelopeSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    details: z.record(z.unknown()).optional(),
  }).strict(),
}).strict();

export const HandshakeRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  deviceId: IdSchema.optional(),
  deviceName: z.string().min(1).max(128).optional(),
  lastAppliedSequence: SafeIntegerSchema.optional(),
  capabilities: z.array(z.string().min(1).max(64)).max(64).default([]),
}).strict();

export const HandshakeResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  vaultId: IdSchema,
  deviceId: IdSchema,
  latestSequence: SafeIntegerSchema,
  minimumRetainedSequence: SafeIntegerSchema,
  readOnly: z.boolean(),
  limits: z.object({
    inlineTextBytes: SafeIntegerSchema,
    blobChunkBytes: SafeIntegerSchema,
    maxOperationsPerBatch: PositiveSafeIntegerSchema,
    requestsPerMinute: PositiveSafeIntegerSchema,
    manifestPageSize: PositiveSafeIntegerSchema,
    manifestTtlSec: PositiveSafeIntegerSchema,
    uploadTtlSec: PositiveSafeIntegerSchema,
  }).strict(),
  capabilities: z.array(z.string()),
}).strict();

export const PairingCodeRequestSchema = z.object({
  deviceNameHint: z.string().min(1).max(128).optional(),
}).strict();
export const PairingCodeResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  code: z.string().min(20).max(256),
  expiresAt: IsoDateSchema,
}).strict();
export const PairRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  code: z.string().min(20).max(256),
  deviceId: IdSchema,
  deviceName: z.string().min(1).max(128),
}).strict();
export const PairResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  vaultId: IdSchema,
  deviceId: IdSchema,
  token: z.string().min(32),
}).strict();

export const WsTicketResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  ticket: z.string().min(32),
  expiresAt: IsoDateSchema,
}).strict();

export const ManifestPageSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  snapshotId: IdSchema,
  snapshotSequence: SafeIntegerSchema,
  nextCursor: z.string().min(1).nullable(),
  entries: z.array(SyncEntrySchema),
}).strict();

export const ChangesResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  latestSequence: SafeIntegerSchema,
  nextAfter: SafeIntegerSchema,
  hasMore: z.boolean(),
  events: z.array(SyncEventSchema),
}).strict().superRefine((value, ctx) => {
  for (let index = 1; index < value.events.length; index += 1) {
    const previous = value.events[index - 1];
    const current = value.events[index];
    if (previous && current && current.sequence !== previous.sequence + 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events', index, 'sequence'], message: 'events must be contiguous' });
    }
  }
});

export const AckRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  sequence: SafeIntegerSchema,
}).strict();
export const AckResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  acknowledgedSequence: SafeIntegerSchema,
}).strict();

export const OperationsRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  operations: z.array(SyncOperationSchema).min(1).max(DEFAULT_LIMITS.maxOperationsPerBatch),
}).strict();
export const OperationsResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  latestSequence: SafeIntegerSchema,
  results: z.array(OperationResultSchema),
}).strict();

export const BlobUploadCreateRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  hash: Sha256Schema,
  size: PositiveSafeIntegerSchema,
  chunkSize: z.number().int().min(1).max(DEFAULT_LIMITS.blobChunkBytes),
}).strict();
export const BlobUploadCreateResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  uploadId: IdSchema,
  missingParts: z.array(SafeIntegerSchema),
  expiresAt: IsoDateSchema,
}).strict();
export const BlobUploadCompleteResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  hash: Sha256Schema,
  size: SafeIntegerSchema,
  deduplicated: z.boolean(),
}).strict();

export const ConflictSchema = z.object({
  conflictId: IdSchema,
  entryId: IdSchema.optional(),
  path: VaultPathSchema,
  kind: z.enum(['revision', 'path', 'delete', 'rename', 'binary']),
  actor: ActorSchema,
  baseRevision: SafeIntegerSchema.nullable(),
  currentRevision: SafeIntegerSchema.nullable(),
  submittedHash: Sha256Schema.optional(),
  currentHash: Sha256Schema.optional(),
  conflictPath: VaultPathSchema.optional(),
  status: z.enum(['unresolved', 'resolved']),
  createdAt: IsoDateSchema,
  resolvedAt: IsoDateSchema.optional(),
}).strict();
export const ConflictsResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  conflicts: z.array(ConflictSchema),
}).strict();
export const ConflictResolutionRequestSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  clientSequence: PositiveSafeIntegerSchema,
  resolution: z.enum(['keep-server', 'keep-client', 'merged', 'copy']),
  mergedContent: ContentReferenceSchema.optional(),
  idempotencyKey: z.string().min(16).max(256),
}).strict().superRefine((value, ctx) => {
  if (value.resolution === 'merged' && !value.mergedContent) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mergedContent'], message: 'merged resolution requires content' });
  }
  if (value.resolution !== 'merged' && value.mergedContent) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mergedContent'], message: 'mergedContent is only valid for merged resolution' });
  }
});

export const DeviceSchema = z.object({
  deviceId: IdSchema,
  name: z.string().min(1).max(128),
  createdAt: IsoDateSchema,
  lastSeenAt: IsoDateSchema.nullable(),
  acknowledgedSequence: SafeIntegerSchema,
  revokedAt: IsoDateSchema.nullable(),
}).strict();
export const DevicesResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  devices: z.array(DeviceSchema),
}).strict();

export const SyncChangedMessageSchema = z.object({
  type: z.literal('sync.changed'),
  vaultId: IdSchema,
  latestSequence: SafeIntegerSchema,
}).strict();

export const ProtocolSchemaRegistry = {
  SyncEntry: SyncEntrySchema,
  SyncEvent: SyncEventSchema,
  SyncOperation: SyncOperationSchema,
  OperationResult: OperationResultSchema,
  ErrorEnvelope: ErrorEnvelopeSchema,
  HandshakeRequest: HandshakeRequestSchema,
  HandshakeResponse: HandshakeResponseSchema,
  PairingCodeRequest: PairingCodeRequestSchema,
  PairingCodeResponse: PairingCodeResponseSchema,
  PairRequest: PairRequestSchema,
  PairResponse: PairResponseSchema,
  WsTicketResponse: WsTicketResponseSchema,
  ManifestPage: ManifestPageSchema,
  ChangesResponse: ChangesResponseSchema,
  AckRequest: AckRequestSchema,
  AckResponse: AckResponseSchema,
  OperationsRequest: OperationsRequestSchema,
  OperationsResponse: OperationsResponseSchema,
  BlobUploadCreateRequest: BlobUploadCreateRequestSchema,
  BlobUploadCreateResponse: BlobUploadCreateResponseSchema,
  BlobUploadCompleteResponse: BlobUploadCompleteResponseSchema,
  Conflict: ConflictSchema,
  ConflictsResponse: ConflictsResponseSchema,
  ConflictResolutionRequest: ConflictResolutionRequestSchema,
  Device: DeviceSchema,
  DevicesResponse: DevicesResponseSchema,
  SyncChangedMessage: SyncChangedMessageSchema,
} as const;

export type SyncEntry = z.infer<typeof SyncEntrySchema>;
export type SyncEvent = z.infer<typeof SyncEventSchema>;
export type SyncOperation = z.infer<typeof SyncOperationSchema>;
export type OperationResult = z.infer<typeof OperationResultSchema>;
export type Conflict = z.infer<typeof ConflictSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type ProtocolError = z.infer<typeof ErrorEnvelopeSchema>;

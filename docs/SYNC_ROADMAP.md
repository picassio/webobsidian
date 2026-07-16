# WebObsidian Central Sync Roadmap

> Status: Implemented through local technical-preview gate; external stable-release gates open · Created: 2026-07-12 · Updated: 2026-07-13 · PRD: FR-13
>
> Normative language: **MUST**, **MUST NOT**, **SHOULD**, and **MAY** carry their RFC 2119 meanings.
> [`PRD.md`](../PRD.md) defines product scope; this document defines the executable architecture and delivery
> contract; [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) phases 31–40 track completion.
> Contradictions are resolved in that order.
>
> This roadmap turns WebObsidian into the authoritative vault server for three clients:
> the existing browser, a native Obsidian community plugin, and a Linux headless client.
> Git remains backup/version history and is no longer described as the primary sync protocol.

## 1. Outcome

```text
Obsidian desktop/mobile + community plugin ─┐
WebObsidian browser ─────────────────────────┼── Sync Protocol v1 ── WebObsidian server
Linux headless client / sidecar ─────────────┤                         ├─ authoritative vault
Agent API ───────────────────────────────────┘                         ├─ revision index
                                                                       ├─ ordered journal
                                                                       ├─ conflict versions
                                                                       └─ QMD/link indexes

Git remote ◀──────── server-only backup/export snapshots (not live synchronization)
```

The server is authoritative. Every mutation, regardless of origin, passes through one revisioned
mutation coordinator. Each vault's coordinator/revision journal is always active; its settings v4 registry record
permits pairing only when `sync.enabled=true` and `sync.bootstrapState=ready`, while existing vaults start
`backup-required` until confirmed
full-backup migration. These settings gate remote access, not write safety. Clients can
disconnect, reconnect, ask for all changes after their last cursor, and never silently overwrite a revision they
did not edit.

## 2. Definitions and product boundary

### 2.1 “Sync v1” means

- Bidirectional file-level synchronization with seconds-level convergence while clients are active.
- Deterministic catch-up after disconnect using an ordered server sequence.
- Revision-safe writes using an expected base revision.
- Explicit create, modify, rename, delete, mkdir, and rmdir operations.
- Text and binary attachment support.
- Offline queue with idempotent replay.
- Conflict detection and recoverable conflict copies; no silent last-writer-wins.
- One protocol shared by browser, native Obsidian plugin, headless client, and agent mutations.

### 2.2 Sync v1 does not mean

- Character-level collaborative editing, shared cursors, or CRDT/OT.
- Guaranteed background sync while iOS/Android has suspended Obsidian.
- Obsidian’s proprietary Sync protocol or compatibility with its servers.
- End-to-end encryption where the WebObsidian server cannot read content. Server-side QMD requires
  plaintext at the trusted self-hosted server. HTTPS remains mandatory outside localhost.
- Synchronization of `.git`, trash, temporary files, `.obsidian/**`, or per-device workspace state.
- Standalone native executables, Debian packages, or RPM packages; v1 headless delivery is npm + Docker +
  a tested systemd unit.

### 2.3 Default synchronized scope

Included by default:

- Markdown and text files.
- Canvas and other Obsidian vault content files.
- Images, PDFs, audio, video, and arbitrary attachments.
- Empty folders through explicit directory operations.

Excluded by default:

- `.git/**`, `.trash/**`, `node_modules/**`.
- `*.tmp-*`, editor swap files, OS metadata (`.DS_Store`, `Thumbs.db`).
- Sync client state and credentials.
- All `.obsidian/**` content in v1, including workspace, plugin state, themes, snippets, and caches.

The v1 rule is deliberately unambiguous: `.obsidian/**` is excluded. A future PRD version may introduce a
server-owned allowlist after per-file compatibility and privacy analysis; no v1 client exposes a setting that
implies those files are protected by sync. Plugin/headless cursor, queue, and credential files are always outside
the synchronized namespace.

## 3. Architectural decisions

| Decision | Choice | Reason |
|---|---|---|
| Authority | WebObsidian server | One place decides revisions and conflicts. |
| Unit of v1 synchronization | Whole file/blob | Fits Obsidian Vault API and headless filesystem clients. |
| Ordering | Global monotonic `sequence` | Simple deterministic reconnect/catch-up. |
| Identity/version | Stable `entryId` + integer `revision` + SHA-256 | Rename-safe identity and stale-write protection. |
| Notification | Authenticated WebSocket wake-up | REST change feed remains recoverable source of truth. |
| Write safety | Required `baseRevision` | Prevents stale clients overwriting newer content. |
| Retry safety | Device/client sequence + idempotency key | Offline retries cannot duplicate operations. |
| Text conflict | Three-way merge when provably clean; otherwise conflict copy | Data safety over clever automation. |
| Binary conflict | Conflict copy | Binary merge is unsafe. |
| Runtime metadata | Atomic segmented JSON + write-ahead transaction intents | Preserves no-database v1 while defining crash recovery. |
| Plugin repository | Separate public repository | Obsidian submission expects manifest/release at repository root. |
| Shared implementation | Versioned `@picassio/sync-core` package | Avoid protocol drift between plugin and headless client. |
| Git | Server-only backup/export | Git snapshots remain useful but are not live sync. |
| `.obsidian` | Excluded entirely in v1 | Avoids device-state loops and undocumented plugin-data semantics. |
| Workspace | Per-device by default | Opening a note on one device MUST NOT switch another device. |
| Transport security | HTTPS outside loopback | Device credentials MUST NOT traverse plaintext networks. |
| Protocol support | Current + previous minor, same major | Enables rolling upgrades; major mismatch fails closed. |
| Vault tenancy | Multiple isolated vault runtimes per server process | One login can manage several knowledge bases without mixing revision, device, blob or conflict domains. |

### 3.1 Multi-vault runtime boundary

Each registered vault owns a stable protocol `vaultId`, filesystem root and isolated runtime data directory. The
migrated default vault preserves the existing `data/sync/` layout; additional vaults use
`data/vaults/<vaultId>/`. Coordinator, journal sequence, revision projection, devices/tokens, pairing codes,
uploads/blobs, conflicts, retention, watcher, search/link/file indexes, Git backup, shares and workspace are never
shared across vaults. Global password/session auth remains shared.

Legacy web/session/Agent URLs select the default vault when no `X-WebObsidian-Vault-Id` is supplied. New web UI
requests send that header and vault-aware deep links. Device tokens are intrinsically bound to one vault, so
existing plugin/headless clients and Sync Protocol 1.0 URLs remain compatible: authentication selects the runtime;
a client cannot override it with a header. Pairing codes are created for one explicit vault. Browser device
credentials are stored in vault-specific httpOnly cookies.

Vault registration accepts existing directories but never copies or deletes their files. Roots must be real,
allowed, non-overlapping directories. Settings v3 migration reads the existing sync `vaultId`, creates exactly one
default registry entry and leaves vault/sync bytes in place. Rollback can therefore use the pre-migration settings
backup without moving content. Unregistering stops the runtime and removes only its registry entry; data cleanup is
an explicit separate operator action.

## 4. Repository and package topology

Main WebObsidian repository:

```text
webobsidian/
├── packages/
│   └── sync-core/                 # protocol types, hashing, filters, merge helpers, client engine
├── server/src/sync/
│   ├── coordinator.ts             # sole mutation authority
│   ├── journal.ts                 # global sequence + segmented JSON journal
│   ├── revision-store.ts          # current path metadata/tombstones
│   ├── blobs.ts                   # content-addressed binary storage/streaming
│   ├── devices.ts                 # pairing, hashed device tokens, revocation
│   ├── reconcile.ts               # external filesystem change ingestion
│   └── routes.ts                  # /api/sync/v1
├── clients/
│   └── headless/
│       ├── src/                    # CLI, filesystem adapter, daemon
│       ├── packaging/systemd/
│       └── Dockerfile
├── web/src/lib/sync/               # browser adapter around sync-core
├── docs/SYNC_ROADMAP.md
└── docs/sync/                    # OpenAPI 3.1, generated JSON Schema, artifact guide
```

Separate community plugin repository:

```text
central-vault-sync/
├── src/main.ts
├── src/obsidian-adapter.ts
├── src/settings.ts
├── src/status-view.ts
├── manifest.json                  # id: central-vault-sync
├── versions.json
├── README.md
├── LICENSE
└── .github/workflows/release.yml
```

The display name may mention compatibility with WebObsidian, but the manifest ID must not contain
`obsidian`, per current community-directory rules.

## 5. Sync Protocol v1

Protocol versions use `major.minor`; v1 starts at `1.0`. Every response includes `protocolVersion`.
The server supports the current and immediately previous minor of the same major. Unknown major versions fail
with `426 protocol_incompatible`; unsupported old minors fail with `410 client_upgrade_required`. HTTP JSON uses
UTF-8, ISO-8601 UTC timestamps, non-negative safe integers for `sequence`/`revision`, lowercase 64-character
SHA-256 hex, and normalized vault-relative POSIX paths.

### 5.1 Identity and pairing

- The server owns a stable random `vaultId` stored outside the vault.
- Native/headless clients generate a random `deviceId`; the server binds it and the human-readable name to
  one credential during pairing. Browser devices are registered through the authenticated web session.
- An authenticated administrator creates a 10-minute, single-use pairing code. The client exchanges it once.
- Pairing codes are stored as HMAC-SHA-256 using a server secret and are attempt-rate-limited; high-entropy
  device tokens are stored as SHA-256 hashes. Raw codes/tokens are never persisted or logged.
- Tokens have only the dedicated `sync` scope, can be listed/revoked, and record last-seen/acknowledged sequence.
- The authenticated token determines `deviceId`; a request body cannot impersonate another device.
- Obsidian stores the token through `SecretStorage`; headless uses a mode-0600 file, environment secret, or
  systemd credential. Tokens never live inside the vault. The browser uses its httpOnly session cookie and a
  server-issued per-browser device identity, not a copied sync token.

### 5.2 Endpoint surface

```text
POST   /api/sync/v1/pairing-codes         # web-admin session: create one-time code
POST   /api/sync/v1/pair                  # public+rate-limited: code → bound device token
POST   /api/sync/v1/handshake             # session/device: identity, limits, latest sequence
POST   /api/sync/v1/ws-tickets            # session/device: one-use 60s WebSocket ticket
GET    /api/sync/v1/manifest              # session/device: snapshot-consistent, paginated
GET    /api/sync/v1/changes?after=&limit= # session/device: ordered committed event feed
POST   /api/sync/v1/ack                   # session/device: durable applied sequence
GET    /api/sync/v1/files?entryId=&revision= # session/device: exact retained revision
HEAD   /api/sync/v1/blobs/:sha256         # session/device: dedupe/probe
POST   /api/sync/v1/blob-uploads           # session/device: create resumable upload
PUT    /api/sync/v1/blob-uploads/:id/:part # session/device: bounded chunk upload
POST   /api/sync/v1/blob-uploads/:id/complete # verify hash and publish blob
GET    /api/sync/v1/blobs/:sha256         # session/device: streamed/ranged download
POST   /api/sync/v1/operations            # session/device: ordered idempotent operation batch
GET    /api/sync/v1/conflicts             # device: own conflicts; web session: all conflicts
POST   /api/sync/v1/conflicts/:id/resolve # session/web-admin: resolve through coordinator
GET    /api/sync/v1/devices               # web-admin session only
DELETE /api/sync/v1/devices/:id           # web-admin session only: revoke
GET    /api/sync/v1/health                # web-admin session only: journal/revision health
```

`pair` is the only endpoint accepting neither a session nor device token. Pairing-code creation, device listing,
revocation, global conflict management, and health are web-admin operations. Device clients can read/apply the
vault and manage conflicts involving their submissions, but cannot enumerate or revoke other devices.

WebSocket connects to `/ws?ticket=<single-use-ticket>`; browser sessions may continue using the session cookie.
A ticket expires after 60 seconds and is consumed on upgrade, so long-lived device tokens never appear in URLs.
Authenticated message:

```json
{ "type": "sync.changed", "vaultId": "...", "latestSequence": 1845 }
```

The WebSocket carries no authoritative content. It only tells clients to call the ordered REST feed. Clients MUST
also poll `handshake` every 30 seconds while active (with jitter) because notifications can be missed; mobile
foreground performs an immediate handshake before resuming the interval.

### 5.3 Core metadata

```ts
type SyncEntry = {
  entryId: string;            // stable random identity preserved across rename
  path: string;               // NFC-normalized POSIX path; display casing preserved
  kind: 'file' | 'directory';
  revision: number;           // increments for content, rename, and deletion state changes
  hash: string | null;        // current lowercase SHA-256; null for directories/tombstones
  size: number;
  modifiedAt: string;         // informational only; never used for conflict ordering
  deleted: boolean;
  sequence: number;
};

type SyncEvent = {
  sequence: number;
  eventId: string;
  actor: { type: 'device' | 'web' | 'agent' | 'server-fs' | 'git-import'; id: string };
  operation: 'create' | 'modify' | 'rename' | 'delete' | 'mkdir' | 'rmdir';
  entryId: string;
  path: string;               // destination/current path
  oldPath?: string;
  baseRevision: number | null;
  revision: number;
  hash: string | null;
  previousHash?: string;      // retained on delete/content replacement for recovery/history
  size: number;               // resulting bytes; zero for directory/tombstone
  occurredAt: string;
};
```

### 5.4 Mutation contract

Each operation carries:

- Strictly increasing `clientSequence` for the authenticated device.
- Globally unique `idempotencyKey` (`<deviceId>:<clientSequence>:<random-suffix>`).
- `entryId` for existing entries and `baseRevision` observed before the edit; both are absent only for create.
- Operation-specific normalized path, content hash, inline UTF-8 content (≤1 MiB), or completed blob hash.

A batch is ordered but not all-or-nothing: the server processes each operation sequentially and returns one result
per operation. A conflict for one path does not block independent later paths; operations that depend on a failed
prior operation are rejected as `424 dependency_failed`. Maximum batch size is advertised by `handshake`.

Server behavior:

1. Authenticate and derive actor/device identity; validate protocol, path, filter, size, and dependency.
2. Return the stored result for a repeated idempotency key without reapplying it.
3. Serialize overlapping path/subtree mutations through the coordinator.
4. Compare `entryId` and `baseRevision` to current state; destination collisions are conflicts.
5. On match: commit atomically under the transaction procedure in §6.1, update derived indexes, and publish the
   newest sequence only after the journal commit point.
6. On mismatch: return `409 revision_conflict` with base/current/submitted references; never overwrite.

A directory rename is one event whose `entryId` remains stable. It atomically rewrites the path prefix of all live
descendants in the revision snapshot; clients perform the same subtree rename. Concurrent descendant operations
resolve by stable `entryId`, not stale path. Path comparison is NFC-normalized; case-fold collision checks use the
strictest supported target behavior so a vault cannot contain paths that collide on Windows/macOS clients.

### 5.5 Bootstrap

The client must choose one explicit mode:

- **Download server vault**: server wins; suitable for a new/empty local vault.
- **Upload local vault**: only allowed when the server vault is empty or after administrator confirmation.
- **Merge**: compare full manifests; equal hashes converge, one-sided paths copy, ambiguous paths become
  conflicts requiring preview/confirmation.

`manifest` starts a snapshot under the journal lock by copying the revision map into an immutable temporary
snapshot, then releases the lock. It returns `snapshotId`, `snapshotSequence`, and an opaque page cursor; every page
belongs to that snapshot. Snapshot TTL is 15 minutes and page size defaults to 1,000; expiration returns
`410 manifest_expired` and the client restarts bootstrap. After applying the manifest, the client requests changes
after `snapshotSequence`, preventing a bootstrap race. Bootstrap supports a dry-run summary and requires explicit
confirmation before destructive replacement. It checkpoints after bounded batches so it can resume after failure.
A client does not advance or acknowledge its cursor until corresponding local writes and local state are durable.

#### 5.5.1 Initial-pairing performance and progress contract

Current profiling identifies three multiplicative bottlenecks rather than a protocol/server limit:

1. `OrderedSyncClient.flushLoop` sends one operation per `/operations` request although Protocol 1.0 already permits
   100, so request latency and the 600-request data bucket dominate a large local bootstrap.
2. The plugin scans/hashes paths one at a time, persists the complete plugin state for each discovered marker and
   operation, then serializes upload → enqueue → publish per path. Rewriting metadata arrays and awaiting every
   persistence/network step makes reconciliation proportional to paths times storage/network latency.
3. Blob create/part/complete calls and files are fully serial. The status bar exposes only a coarse state/lag, so a
   correct long bootstrap appears stalled and diagnostics cannot distinguish scanning, transfer, publication or apply.

Implementation contract:

- **Ordered publication:** read one durable queue snapshot, sort by positive `clientSequence`, and submit contiguous
  slices of at most `min(100, server-advertised maxOperationsPerBatch)` only when the server advertises
  `ordered-batch-stop-v1`; older Protocol 1.0 servers safely remain at one operation/request. The capability guarantees
  that after the first non-success the server returns `dependency_failed` without executing later rows, preventing a
  higher accepted client sequence from stranding an earlier retained rejection. Request/response shapes do not change.
  Never reorder across slices. Validate that each result corresponds to exactly one submitted
  `idempotencyKey`; a missing, duplicate or unknown result is a retryable failure and leaves uncertain operations.
- **Per-result durability:** process results in submitted order. For `accepted`/`merged`, finish the adapter's
  idempotent committed projection before durable queue removal. For `conflict`, durably record/surface the conflict
  before removal. `rejected` and `dependency_failed` remain queued. Reconcile every returned result because the
  non-atomic server may already have committed later independent rows, then stop before submitting another slice if
  the slice contains a rejected/dependency-failed result. Thus a crash after response but between removals safely
  retries only the retained suffix with the same client sequences/idempotency keys.
- **Local-before-remote:** startup, wake and polling attempt all publishable durable local slices before fetching
  newer remote bytes. A stopped slice may then enter the existing conflict/reconciliation flow; it must never be
  bypassed by silently applying a remote overwrite.
- **Safe startup lifecycle:** after retained-intent recovery, fetch the immutable manifest, then scan/checkpoint local
  paths in `beforeBootstrap` before any manifest entry is materialized. The adapter protects both durable pending-path
  markers and queued operations. After bootstrap and cursor persistence, `beforeInitialFlush` converts retained markers
  through bounded uploads into durable operations; core publishes them before `beforeInitialCatchUp` allows remote
  catch-up. Awaited callbacks report recovery completion, per-result queue removal, and normal event durability only
  after their corresponding persistent transition; callback failure follows the normal offline/retry path.
- **Reconciliation plan:** inventory excluded-safe paths in deterministic parent-before-child/canonical-path order,
  compare against the indexed projection, and collect metadata-only work in bounded checkpoints. An unchanged path
  causes no plugin-state write and no network request. Startup-discovered work may be recomputed after a crash;
  live Vault events still persist their marker before debounce/yield. Before publication, every generated operation
  is durable and its source marker is removed only after that enqueue succeeds. A persistence adapter may atomically
  remove all terminal results from one acknowledged batch; a crash before that write replays the unchanged batch and
  a crash after it cannot resurrect only part of the removed set.
- **Bounded concurrency:** hashing/reading and blob transfer may overlap, but memory and network concurrency are
  explicit. The plugin default and acceptance cap is 4 concurrent file uploads; each file's resumable parts remain
  ordered and hash-verified. Upload completion may occur out of order, but client sequence allocation/enqueue and
  operation publication follow deterministic plan order. No full-vault content buffer is allowed.
- **Crash and safety invariants:** restart rescans incomplete inventory/checkpoints, resumes server upload state, and
  idempotently republishes retained operations. Cursor/ack still advance only after durable local apply intents.
  Revision/base checks, server conflict outcomes, one-vault token binding, server/client excludes, echo suppression,
  unsaved-editor deferral, and SHA-256 verification are unchanged. Plugin state may contain sync metadata, hashes,
  blob references and durable operation descriptors, but never note bytes/text; progress and diagnostics never contain
  token/authorization data or private paths.

Live progress is an in-memory observation, not protocol or authority state. Phase units are fixed so every surface
reports the same meaning:

| Phase | Completed item | Bytes |
|---|---|---|
| `recovering` | durable apply intent recovered | bytes are unknown/absent |
| `manifest` | manifest entry received | metadata bytes are unknown/absent |
| `scanning` | eligible local path inventoried and hashed when required | local file payload bytes inspected |
| `uploading` | file whose required blob upload completed or deduplicated | verified payload bytes available remotely |
| `publishing` | operation result durably reconciled | payload bytes referenced by reconciled operations |
| `applying` | remote event durably materialized and its apply intent removed | downloaded/materialized payload bytes |
| `finalizing` | final cursor/ack/conflict-refresh step completed | bytes are unknown/absent |

```text
phase = recovering | manifest | scanning | uploading | publishing | applying | finalizing
completedItems, totalItems?      # non-negative; completed is monotonic within a phase
completedBytes, totalBytes?      # payload bytes, not wire/compression estimates
queuedOperations, conflicts
startedAt, updatedAt, resumed
```

Unknown totals stay absent until discovered; they are never displayed as zero. Phase order is monotonic except a
retry may restart the current phase with `resumed=true`. Emit the first snapshot within 1 second of starting and
coalesce UI updates to at most four per second while guaranteeing an update at each phase transition/completion.
Status bar uses a concise phase plus count/bytes; Settings shows the full current snapshot and last completed summary;
redacted diagnostics exports the same aggregate fields and request counts, never content or paths. Terminal
`synced/offline/conflict/error/disabled` remains connection state, orthogonal to the active progress phase.

### 5.6 Reconnect and offline replay

1. Client records the last durably applied server sequence outside the vault.
2. On reconnect, call `changes?after=<cursor>` until caught up.
3. Apply remote changes with echo suppression.
4. Rebase/revalidate queued local operations against current revisions.
5. Submit operations in order with idempotency keys.
6. Resolve `409` conflicts without blocking unrelated paths.
7. Persist the new cursor only after local application succeeds, then `POST /ack`.

The server tracks last acknowledged sequence/time per device. Revoked devices and devices inactive for more than
the configured 90-day retention do not block compaction. If a cursor is older than retained history, server returns
`410 cursor_expired`; client performs snapshot-consistent manifest reconciliation rather than guessing. Event-
referenced file/blob revisions remain fetchable until the event can no longer be requested by any retained cursor.

### 5.7 Conflict behavior

Text conflict inputs:

- Base revision content retained by the server.
- Current server content.
- Client-submitted content.

Policy:

- Text means valid UTF-8 in the configured text-extension allowlist and ≤10 MiB. The server performs a
  deterministic line-oriented diff3 against exact base/current/submitted bytes, normalizing line endings only
  during comparison and emitting the current file’s line-ending style. Non-overlapping hunks are clean.
- If diff3 is clean, store the merge as a new revision and preserve all three revision references.
- If hunks overlap, the base is unavailable, decoding fails, or the file exceeds the merge limit, keep current
  server content at the canonical path and create a server-unique conflict copy named
  `<name> (conflict from <device> <UTC timestamp>[ N]).<ext>` through the coordinator.
- Binary divergence always creates a conflict copy.
- Delete-vs-modify never silently deletes the modification; restore it as a conflict copy.
- Rename-vs-modify follows file identity/event history, not only path names.

Required conflict matrix:

| Client operation vs intervening server state | Deterministic result |
|---|---|
| create same path, same kind/hash | Converge to existing entry; return its identity/revision without duplicate event. |
| create same path, different hash or file-vs-directory | `path_collision`; preserve both via user-selected/automatic unique conflict path. |
| modify vs modify, text | Clean diff3 → merged revision; otherwise canonical current + conflict copy. |
| modify vs modify, binary | Same hash converges; different hash creates conflict copy. |
| modify after metadata-only rename of same `entryId` | Rebase to canonical new path; then normal hash/diff3 rules. |
| rename while server only modified same `entryId` | Apply rename to current content if destination is free; content is not reverted. |
| rename vs different rename | Same destination converges; different destinations keep server path and record conflict. |
| delete vs any intervening modify/rename | Do not delete; keep server entry and create unresolved delete conflict. |
| modify/rename vs server tombstone | Keep tombstone; submitted bytes become conflict copy or rename conflict. |
| delete vs same tombstone | Converge idempotently. |
| directory rename vs descendant modify | Stable descendant identities move with prefix; modification is retained/merged. |
| rmdir on non-empty or changed subtree | Reject `revision_conflict`; recursive delete must be explicit ordered child operations. |
| case-only rename | Accept only without folded collision; adapter uses recoverable temporary path where required. |

- Server trash is not synchronized. Delete creates a tombstone while moving bytes to server trash; restore reuses
  the tombstoned `entryId` with a new revision when the original identity/path is available, otherwise it restores
  to a unique path as a new entry and records the relationship.
- Server-side copy is not a wire operation: it expands into ordered mkdir/create events with new `entryId` values.
  Agent append is one modify event; Git import emits normal per-entry events.
- Conflicts remain visible in server UI, plugin status, and headless `status` until acknowledged/resolved.

### 5.8 Canonical outcomes and errors

Every JSON error has `{ protocolVersion, error: { code, message, retryable, details? } }`; clients branch on
`code`, never localized `message`. Required codes:

| HTTP | Code | Client action |
|---:|---|---|
| 400 | `invalid_request` / `invalid_path` / `hash_mismatch` | Do not retry unchanged input. |
| 401 | `authentication_required` / `token_invalid` | Re-pair or restore session. |
| 403 | `scope_denied` / `device_revoked` / `insecure_transport` | Stop and require operator action. |
| 409 | `revision_conflict` / `path_collision` / `client_sequence_reused` | Enter conflict/reconciliation flow. |
| 410 | `cursor_expired` / `manifest_expired` / `client_upgrade_required` / `revision_expired` | Restart manifest, upgrade, or conflict-copy. |
| 413 | `payload_too_large` / `quota_exceeded` | Use blob chunks or free/increase quota. |
| 424 | `dependency_failed` | Do not apply dependent operation; continue independent results. |
| 426 | `protocol_incompatible` | Stop safely; never downgrade silently. |
| 429 | `rate_limited` | Retry after advertised delay with jitter. |
| 503 | `sync_read_only` / `temporarily_unavailable` | Preserve queue and retry; show operator diagnostics. |

Successful mutation results include `eventId`, `sequence`, `entryId`, `revision`, `hash`, canonical `path`, and
`merged/conflictId` where applicable. Repeating an idempotency key returns byte-equivalent semantic fields.

### 5.9 Local application safety

Plugin and headless clients maintain a local apply-intent before mutating the local vault/filesystem. After restart
they compare expected hash/path and either finish the apply, mark it applied, or raise a local conflict; they never
advance the server cursor past an uncertain local mutation. A subtree rename is checkpointed as one logical event
even if the platform adapter performs multiple filesystem steps. Browser IndexedDB stores cursor, per-document
revision, pending operations, and drafts; localStorage is not used for durable sync queues.

## 6. Server implementation roadmap

### 6.1 Revision store and journal

Runtime layout:

```text
data/sync/
├── vault.json                    # vaultId, currentSequence, schemaVersion
├── revisions.json                # current entries + tombstones
├── devices.json                  # hashes/metadata only
├── idempotency.json              # bounded recent operation results
├── transactions/                 # fsynced write-ahead intents; empty in steady state
├── journal/
│   ├── 00000001.json             # bounded committed-event segments
│   └── 00000002.json
├── bases/                        # retained text bases needed for merge window
├── blobs/sha256/ab/cd...         # staged/current/event-retained binary blobs
├── uploads/                      # incomplete resumable chunks with expiry
└── conflicts.json
```

Requirements:

- Atomic temp-write + file fsync + rename + parent-directory fsync for metadata snapshots and active segment.
- The active segment is a bounded JSON document rewritten atomically; sealed segments are immutable. Every segment
  includes schema version, first/last sequence, event count, and checksum.
- Revision snapshots are rebuildable caches over committed journal events plus a vault scan; the journal commit
  point, not snapshot-write timing, determines whether clients can observe an operation.
- Compaction occurs only after retained device acknowledgements and retention policy permit it.
- Tombstone, event, merge-base, and event-referenced blob retention default to 90 days. Expired bases disable
  auto-merge and force conflict-copy; they never permit overwrite.
- Incomplete uploads expire after 24 hours. Current vault blobs remain referenced; unreferenced blobs are removed
  only after journal/base/conflict retention no longer needs them.
- `sync doctor` verifies vault files, hashes, revision state, transaction intents, uploads, and journal continuity.

Crash-safe coordinator transaction:

1. Under path/subtree + journal locks, validate base state and compute target revision/sequence/result.
2. Stage new content and previous recoverable bytes; write and fsync a transaction intent containing the full
   idempotency result and target event.
3. Atomically materialize the vault mutation and fsync its parent directory.
4. Append the committed event by atomically replacing/fsyncing the active journal segment. This is the commit point.
5. Update the revision/idempotency snapshots, publish subscribers/WebSocket, and delete the intent.
6. Send success only after step 4. If recovery finds an intent before step 4, it deterministically finishes the
   same event when materialized bytes match the intent, otherwise restores previous bytes and records no event.
   If step 4 completed, replay rebuilds snapshots and returns the stored result on retry.

Startup MUST complete intent recovery and journal validation before accepting writes. Unrepairable checksum or
vault/journal divergence starts the service in read-only degraded mode; it never truncates history automatically.

### 6.2 Mutation coordinator

All mutation paths migrate to one coordinator:

- Web file create/write/rename/copy/delete/trash/restore.
- Agent API create/write/append/delete.
- Native plugin operations.
- Headless client operations.
- External filesystem watcher reconciliation.
- Explicit Git restore/import.

The coordinator owns per-path/subtree locks plus a journal commit lock. QMD, backlinks, file index, shares, and
WebSocket become subscribers to committed domain events instead of each route updating them independently.
Derived-index failure never rolls back a committed vault event: it enters a durable retry/rebuild queue, exposes
`indexLagSequence` in health, and prevents a false `Synced` status until caught up.

### 6.3 External filesystem reconciliation

Direct server-side edits remain supported:

- Chokidar waits for stable writes, hashes the resulting file, and compares revision state.
- Coordinator-originated writes register a short-lived `(path, hash)` suppression marker so the watcher does
  not emit a duplicate event.
- Unknown external changes enter as device `server-fs` and receive normal revisions/events.
- Rename correlation uses inode/file identity where available and hash/time heuristics otherwise; uncertain
  cases become delete+create, which remains safe.
- A periodic reconciliation scan repairs missed watcher events.

## 7. Browser client migration

- `GET /api/files/content` returns `revision`, `hash`, and `ETag` for text.
- Save sends `baseRevision` or `If-Match`; `409` opens a conflict dialog.
- Replace the global dirty boolean race with save generations:
  - Capture generation/content/revision when save starts.
  - Only clear dirty if the same generation is still current.
  - Serialize writes per open document.
- On `sync.changed`, fetch ordered changes:
  - clean open file → fetch and apply new revision;
  - dirty open file → retain edits and enter merge/conflict flow;
  - unrelated paths → update tree/index indicators only.
- Split editor state per tab/path rather than one global `content/dirty` pair.
- Change workspace state from global mirroring to server-side per-device records keyed by browser/plugin device;
  opening a note on one device never changes another device. Existing shared `uistate.json` is copied once into
  the first browser device record and retained as a rollback backup during migration.
- Surface connection state: `Synced`, `Syncing`, `Offline`, `Conflict`, `Error`.
- Add Settings → Sync: devices, pairing codes, revocation, conflict list, journal health, and Git backup mode.

Stable compatibility boundary:

- Stable Sync v1 has no unrevisioned update/rename/delete/copy route. Creating an absent path may omit a base;
  mutating an existing entry requires `baseRevision` or `If-Match` and stale/missing metadata fails without writing.
- Settings v1/v2 are migrated to v3. Existing vaults and legacy Git installs begin with Central pairing disabled
  and `bootstrapState=backup-required`; the migration assistant must complete a full backup before `ready`.
- Existing `/api/v1` reads remain compatible. Agent mutations require positive monotonic `clientSequence`, stable
  `idempotencyKey`, and `baseRevision` for existing notes (428 missing, 409 stale). Sync endpoints version
  independently from Agent API.

## 8. Native Obsidian community plugin

### 8.1 Core behavior

- Desktop and mobile compatible; avoid Node/Electron-only APIs.
- Register Vault create/modify/rename/delete events through plugin lifecycle helpers.
- Debounce noisy modify bursts per path at 750 ms by default, flush on file close/plugin unload when lifecycle
  time permits, and persist a queue marker first so suspend/crash recovery re-hashes unsent paths.
- Use Vault text/binary APIs, `requestUrl`, WebSocket where available, and SecretStorage.
- Run initial catch-up at plugin load, reconnect, workspace focus, and mobile resume.
- Maintain durable cursor/pending queue in plugin data while the server excludes
  `.obsidian/plugins/central-vault-sync/**`; credentials live only in SecretStorage. The plugin awaits durable
  adapter persistence before acknowledging a corresponding local state and uses §5.9 apply intents for recovery.
- Suppress remote-apply echoes by expected `(path, hash, revision)` rather than a timing-only flag.
- Status bar and command palette commands: Sync now, Pause, View status, View conflicts, Reconnect, Reset local
  sync state.

### 8.2 Settings

- Server URL and connection test.
- Pair/unpair device.
- Device name.
- Sync interval/fallback polling when WebSocket is unavailable.
- Display the server-enforced v1 exclusions; clients may add stricter exclude globs but cannot include
  `.git`, `.trash`, `.obsidian`, internal sync paths, or unsafe paths.
- Mobile large-file confirmation threshold defaults to 100 MiB and is configurable; v1 does not claim reliable
  Wi-Fi-only detection across Obsidian platforms.
- Conflict behavior (safe defaults cannot be disabled globally).
- Diagnostics export with secrets redacted.

### 8.3 Mobile constraints

- Never promise synchronization while the app is suspended.
- Persist queue/cursor before yielding.
- Catch up on foreground and show stale/offline state.
- Bound batch size and memory for attachments.
- Test Android and iOS adapter behavior, path case sensitivity, Unicode normalization, and interrupted uploads.

### 8.4 Publication

1. Public repository with README, LICENSE, manifest, versions map, source, and privacy/security notes.
2. CI: lint, typecheck, unit tests, build, secret scan, and plugin-policy checks.
3. GitHub release tag exactly matching `manifest.json` version; attach `main.js`, `manifest.json`, optional CSS.
4. Private alpha → public beta with opt-in testers.
5. Submit initial release through `community.obsidian.md` → Plugins → New plugin.
6. Resolve automated/reviewer feedback with incremented releases.
7. After publication, future releases come from GitHub tags/assets.

## 9. Linux headless client

### 9.1 CLI contract

```text
web-vault-sync init --server <url> --vault <path>
web-vault-sync pair [--code <one-time-code>]
web-vault-sync sync
web-vault-sync watch
web-vault-sync pull [--watch]
web-vault-sync push [--watch]
web-vault-sync status [--json]
web-vault-sync conflicts list|show|resolve
web-vault-sync doctor
web-vault-sync reset --keep-files
```

Stable exit codes are `0` success, `2` completed with unresolved conflicts, `3` configuration/usage, `4` auth or
revocation, `5` network/temporary server, `6` local I/O, `7` protocol incompatibility/cursor recovery required,
`8` another instance holds the vault lock, and `9` doctor found corruption/unhealthy state. Every command supports
machine-readable JSON output with the same code names as the protocol. Logs redact tokens and signed URLs. Local layout is
`~/.config/web-vault-sync/config.json`, mode-0600 credentials (unless external secret), and
`~/.local/state/web-vault-sync/<vaultId>/` for cursor, apply intents, queue, lock, and conflicts; none is under the
synchronized vault.

### 9.2 Daemon behavior

- Chokidar local filesystem adapter with polling fallback.
- Same cursor, revision, queue, filters, hashes, and conflict engine as the plugin.
- Single-instance lock per configured vault.
- Exponential reconnect with jitter and bounded retry.
- Graceful SIGTERM: stop accepting events, persist queue/cursor, then exit.
- Tested `Type=simple` systemd unit with process liveness and CLI `doctor`; v1 does not claim `sd_notify` watchdog.
- Modes have fixed semantics: `bidirectional` applies both directions; `pull-only` treats local mutation as drift,
  restores/quarantines it, and never uploads; `push-only` uploads local operations but fetches metadata and turns
  remote divergence into conflict instead of applying remote content; `one-shot` runs the selected mode to a
  durable cursor/queue boundary and exits.
- Sidecar container runs non-root and supports bind-mounted vault, read-only credentials, healthcheck, and
  reproducible amd64/arm64 builds from the verified source tag; no registry image is published.

### 9.3 Packaging

- Public npm package with `bin` entry for Node 20+ and lockfile-reproducible install.
- Tested systemd unit/install instructions; no standalone executable, Debian package, or RPM in v1.
- Dedicated non-root Dockerfile is CI-built/smoked for amd64/arm64 with SBOM/provenance validation. Operators
  clone the immutable verified source tag and build locally; the project does not publish registry images.

## 10. Git transition

- Rename UI concept from “GitHub Sync” to “Git Backup & Version History”.
- New default mode is single-writer server backup: commit accepted server revisions and push snapshots to a
  dedicated branch controlled only by this server. Non-fast-forward push stops with an actionable backup error;
  the service never pulls, force-pushes, or blocks accepted sync mutations.
- Automatic remote pull into the live authoritative vault is disabled in central-sync mode.
- Restore/import from Git is explicit, previewed, and routed through the mutation coordinator so it creates
  normal revisions/events.
- Legacy bidirectional Git mode remains available only while Central Sync is disabled. Enabling Central Sync
  requires a clean-repository backup and switches Git to backup-only; stable UI offers no concurrent bypass.
- Git LFS remains valid for backup storage but is unrelated to live blob transfer.

## 11. Security and privacy

Trust boundaries: the self-hosted server/operator can read vault plaintext; clients trust the configured server;
network peers, public share visitors, unpaired devices, and other browser origins are untrusted. A paired client is
not an administrator and may be compromised, so server validation remains mandatory.

| Threat | Required mitigation |
|---|---|
| Pairing-code theft/brute force | 128-bit code, 10-minute TTL, single use, HMAC storage, constant-time compare, tight IP/code attempt limit. |
| Device-token theft/replay | ≥256-bit token, SHA-256 at rest, HTTPS, revocation, last-seen audit; idempotency/client sequence limits mutation replay. |
| Stale or malicious overwrite | Token-bound actor, stable entryId + exact baseRevision/hash, coordinator conflict rules; no force flag in device API. |
| Path/symlink escape or case collision | NFC POSIX canonicalization, reserved-prefix rejection, realpath containment, folded collision validation. |
| Blob corruption/quota exhaustion | Declared size/hash, bounded chunks, streaming SHA-256, per-device in-flight/rate quota, expired-upload cleanup. |
| CSRF/cross-origin admin action | SameSite httpOnly session, origin validation and CSRF token on session-authenticated sync admin mutations. |
| Credential leakage via WebSocket/log | One-use 60s WS ticket; never put long-lived token in URL; centralized redaction and secret-scan tests. |
| Journal/metadata tampering or crash | Restricted file modes, checksummed immutable segments, fsynced WAL intents, degraded read-only on unexplained divergence. |
| Compromised paired client enumerating devices | Device endpoints expose only vault sync and own conflicts; device list/revoke/health require web-admin session. |
| Resource starvation | Advertised body/batch/chunk limits, streaming I/O, lock timeouts, queue/backpressure, per-device rate limits. |
| Sensitive diagnostics/publication | No content/token in audit logs; redacted export; plugin privacy/network disclosure reviewed before release. |

- HTTPS required for non-loopback sync endpoints. Plain HTTP is accepted only for loopback, or when the operator
  explicitly sets `WEBOBSIDIAN_SYNC_ALLOW_INSECURE=true`; the server then logs a persistent warning and plugin/
  headless clients require their own per-connection insecure confirmation.
- Dedicated `sync` scope; no reuse of master password or broad agent key by default.
- One-time pairing codes: cryptographically random, hashed, short-lived, single-use.
- Device tokens: high entropy, hashed at rest, revocable, never logged.
- Path traversal and symlink escape checks on every operation and blob materialization.
- Validate normalized UTF-8 paths; reject `.git`, internal sync paths, NUL, absolute paths, and traversal.
- Advertised request/batch/chunk limits enforced per endpoint/device. Defaults: 1 MiB inline text, 8 MiB blob
  chunk, 100 operations/batch, and 600 bootstrap/data requests/minute/device. Handshake/Test uses an independent
  120 requests/minute/device control bucket so diagnostics remain available during transfer; pairing stays at the
  tighter 10 attempts/minute/IP boundary. Every 429 advertises Retry-After.
- SHA-256 verification before accepting or applying content.
- Audit actor, operation, entryId/path, base/result revision, outcome, and timestamp without content or credentials.
- Origin checks and CSRF protection apply to session-authenticated admin mutation endpoints; device-token endpoints
  do not accept cookie fallback. Pair attempts use tighter IP/code rate limits and constant-time comparisons.
- Conflict and diagnostic exports redact server tokens and authorization headers.
- Plugin submission documents network behavior, data destination, retention, and self-hosted trust model.

## 12. Observability and operations

Metrics/logical counters:

- Current bootstrap phase, item/byte totals and completions, operation/blob request counts, elapsed time and resumed
  flag; aggregates only, with no note content or private paths.
- Current sequence and journal lag per device.
- Connected/active/revoked devices.
- Operations accepted, deduplicated, rejected, and conflicted.
- Bytes uploaded/downloaded and blob dedupe ratio.
- Watcher reconciliations, derived-index lag, and drift repairs.
- Journal segment count, retained bases/blobs, compaction status.
- Backup status separated from sync status.

Operator surfaces:

- `/healthz` remains shallow process health.
- Authenticated `/api/sync/v1/health` reports revision/journal health without secrets.
- Settings diagnostics and headless `doctor` produce the same redacted report format.
- Startup refuses silent journal truncation; it enters read-only/degraded mode with a repair instruction.

## 13. Test strategy and release gates

### 13.1 Unit/property tests

- Path normalization/filtering and Unicode/case behavior.
- Hashing, event ordering, revisions, tombstones, idempotency.
- Three-way merge and every conflict matrix.
- Journal segment rotation, recovery, compaction, and schema migration.
- Echo suppression and offline queue replay.
- Autosave generation correctness.

### 13.2 Integration tests

- Two simulated clients concurrently edit the same and different files.
- Disconnect/reconnect with thousands of missed operations.
- Duplicate/reordered HTTP retries, mixed independent/dependent batch outcomes, and exact error codes.
- Create→rename→modify→delete chains.
- Delete-vs-modify and rename-vs-modify.
- Snapshot manifest expiry/restart, acknowledgements, compaction, and cursor-expired reconciliation.
- Text, empty files/folders, large binary files, Range download, interrupted/resumed chunk upload and hash mismatch.
- Direct server filesystem edits and missed watcher event reconciliation.
- Process/client crash injected around local apply intents and every server intent/materialize/journal/snapshot boundary.
- Revoked token, expired pairing code, path traversal, symlink escape, malformed journal.

### 13.3 Client E2E matrix

- Browser × browser.
- Browser × native Obsidian desktop.
- Browser × headless Linux daemon.
- Native plugin × headless daemon.
- Android/iOS foreground catch-up.
- Linux/macOS/Windows path and case behavior.
- amd64/arm64 server and headless images.

### 13.4 Performance gates

Initial targets, validated before beta:

- A deterministic 10k-path unchanged plugin fixture performs zero operation/blob requests and zero per-path durable
  writes; compare median of three runs against the pre-change sequential baseline on the same machine.
- A deterministic 10k small-file local bootstrap uses at most `ceil(N/100)` operations requests, never exceeds four
  concurrent file uploads, reports file/byte/request totals, and is at least 3× faster by three-run median on the same
  machine/network. Rate-limit wait time is reported separately rather than hidden from elapsed time.
- Progress appears within 1 second, refreshes at least every 250 ms while advancing, remains monotonic per phase, and
  reaches exact totals; retry/restart evidence shows `resumed=true` without false completion.
- Batch fault tests cover response loss, crash after each per-result durable removal, missing/reordered result rows,
  conflict/rejection in the middle, and prove ordered idempotent convergence with local-before-remote behavior.
- Plugin fault tests cover crash during scan/upload/checkpoint, exclude enforcement, unsaved editor, one-vault token,
  diagnostics redaction/no paths, and prove no note content is written to plugin state.
- 10k notes / 50k total files manifest pagination without loading all content.
- Incremental no-change handshake/catch-up under 500 ms on LAN after connection.
- Text changes visible to active clean clients within 2 seconds under normal conditions.
- Bounded memory while transferring a 1 GB attachment.
- Journal replay and server restart recovery without O(vault content bytes) full reads in the common case.

Current M42.1 evidence (2026-07-16): plugin fault tests cover scan/checkpoint interruption followed by restart without
false completion, upload failure with durable marker retention, stale prepared work, atomic marker-to-operation commit,
and pending-path protection during bootstrap. Core tests cover recovery/hook ordering and operation/result durability.
`cd ../central-vault-sync && timeout 2400s npm run benchmark:bootstrap` extracts the actual pre-change plugin sources at
`121e03b`, invokes each version's real `main.ts` vault scan plus store, adapter, upload/enqueue, core publication and
reconciliation pipeline against the identical deterministic 10k × 35-byte fixture, and asserts the gates. Three runs
measured a 403,598.88 ms baseline median versus 8,727.62 ms optimized median (**46.24×**); every optimized run published
10,000 operations in exactly **100 operation requests**, uploaded 350,000 bytes, and reduced plugin-state writes from
50,002 to 302. The benchmark's fixed 1 ms loopback operation latency is reported separately, and phase timing logs make
long scan/persistence/publication runs visible.

## 14. Delivery phases, dependencies, and estimates

This table uses the same phase IDs as `IMPLEMENTATION_PLAN.md`; there is no second milestone numbering system.
Estimates are engineering effort, not calendar commitments, and assume one experienced TypeScript engineer.

| Plan phase | Deliverable | Depends on | Estimate | Exit gate |
|---|---|---|---:|---|
| 31 | Contract, decisions, threat model, fixtures | — | 1–2 weeks | Schemas, error codes, conflict matrix, and conformance fixtures approved. |
| 32 | sync-core primitives, revision store, journal, recovery | 31 | 2–3 weeks | Crash/property tests pass; doctor detects divergence. |
| 33 | Coordinator + migration of every server writer | 32 | 2–3 weeks | Static guard and E2E prove no mutation path bypasses revisions. |
| 34 | REST/WS, pairing, devices, acknowledgements, resumable blobs | 31–33 | 2–3 weeks | Two simulated clients converge through disconnect/retry/conflict. |
| 35 | Browser revision model, autosave fix, conflict/device UI | 33–34 | 2–3 weeks | Browser concurrency and stale-open tests have no silent overwrite. |
| 36 | Native Obsidian plugin desktop/mobile | 31–35 | 3–4 weeks | Desktop two-way/offline passes; mobile foreground catch-up passes. |
| 37 | Linux npm CLI/daemon, systemd, sidecar image | 31–35 | 2–3 weeks | One-shot/watch/modes and restart/offline tests pass on amd64/arm64. |
| 38 | Git backup-only transition and explicit import | 33–35 | 1–2 weeks | Git cannot implicitly mutate a Central Sync vault. |
| 39 | Scale, fault injection, security, migration, operations | 32–38 | 3–4 weeks | NFR gates pass; no unresolved critical/high data-loss/security issue. |
| 40 | Technical preview → alpha → beta → stable/publication | 35–39 | 2–3 weeks + review | Artifacts published, plugin accepted, recovery/upgrade drills pass. |
| 42 | Fast initial pairing + live progress | 36, 39 | 1 week + review | 10k/fault gates pass; normal plugin release is prepared, not published, pending orchestrator review. |

Expected total is **21–32 engineer-weeks**, with phases 36, 37, and 38 parallelizable after phase 35. A
Markdown-only technical preview is allowed only as an explicitly labeled pre-stable artifact after phases 31–35;
it does not satisfy FR-13 or any stable acceptance criterion. Full stable includes arbitrary attachments, mobile
foreground catch-up, the headless client, Git transition, and community plugin publication.

## 15. Milestone acceptance criteria

### Server Technical Preview

- Revisions, ordered journal, tombstones, idempotency, and pairing implemented.
- Browser and simulated client reconnect/catch-up work.
- No known silent-overwrite path through web or agent routes.
- Crash recovery and two-client conflict tests pass.

### Private Alpha

- Native desktop plugin and Linux headless daemon synchronize Markdown and attachments.
- Offline replay, rename/delete, revocation, and conflict copies work.
- Git backup is separated from live sync.
- Diagnostics are sufficient to recover without editing metadata by hand.

### Public Beta

- Browser, desktop plugin, mobile foreground catch-up, and headless matrix pass.
- Security review and plugin policy review complete.
- Migration/backup/restore documentation tested from a clean installation.
- No open critical or high-severity data-loss/security issue.

### Stable / Community Directory

- Plugin accepted and installable from Obsidian Community Plugins.
- Headless npm package and systemd example published; documented local Docker build from the verified source
  tag reproduces the CI-tested amd64/arm64 image without a registry dependency.
- Sync protocol compatibility policy documented.
- Upgrade from the previous WebObsidian release preserves vault files and Git history.
- Recovery drills demonstrate restore from metadata corruption, backup, and conflict state.

## 16. Final decision record

These decisions are accepted by PRD 1.5 and are not implementation-time options:

1. **V1 scope:** all normal vault files, empty directories, and arbitrary attachments; all `.obsidian/**` excluded.
2. **Conflict default:** deterministic clean diff3 merge; otherwise unique conflict copy; never silent overwrite.
3. **Encryption:** trusted self-hosted server over HTTPS; no server-blind E2EE in v1 because QMD indexes plaintext.
4. **Plugin repository:** separate public `central-vault-sync` repository with manifest at repository root.
5. **Storage:** write-ahead intents + segmented atomic JSON journal for v1; failure to meet phase-39 NFR requires a
   PRD revision before changing storage technology, not an undocumented substitution.
6. **Git:** backup-only while Central Sync is enabled; import/restore is explicit and coordinator-mediated.
7. **Workspace:** server-side per-device state; no automatic cross-device tab switching.
8. **Compatibility:** current and previous minor in the same protocol major; incompatible major fails closed.
9. **Headless packaging:** npm, tested systemd unit, and non-root amd64/arm64 Docker image; no native/deb/rpm v1.
10. **Collaboration:** file-level synchronization only; CRDT/shared cursors require a future PRD.

Any change to these decisions MUST update `PRD.md` version/changelog, this roadmap, protocol fixtures, and the
corresponding `IMPLEMENTATION_PLAN.md` milestones in the same change.

## 17. Traceability and completion contract

| Roadmap concern | PRD 1.5 source | Implementation evidence owner |
|---|---|---|
| Authority, revisions, journal, tombstones, idempotency | FR-13 Authoritative server through Event model | M31.4–M34.5 |
| Conflict and no silent overwrite | FR-13 Conflict; NFR Tin cậy; DoD 8 | M31.5, M33.2, M35.3–M35.5 |
| Resumable binary/blob transport | FR-13 Attachment lớn; NFR Sync performance | M32.5, M34.4, M35.9 |
| Browser autosave/open-note safety | FR-13 Browser; DoD 8 | M35.1–M35.9 |
| Device pairing/auth/revocation | FR-13 Device auth; DoD 12 | M31.6, M34.1–M34.9 |
| Native Obsidian desktop/mobile plugin | FR-13 Native plugin; DoD 9–10,14 | M36.1–M36.10 |
| Linux headless CLI/daemon/systemd/Docker | FR-13 Linux client; DoD 11,14 | M37.1–M37.8 |
| External filesystem reconciliation | FR-13 Authoritative server | M33.7–M33.9 |
| Per-device workspace migration | FR-13 Browser | M35.1, M35.8 |
| Git backup-only/import | FR-4 transition; FR-13; DoD 13 | M38.1–M38.5 |
| JSON recovery/scale/doctor | FR-13 Storage; NFR reliability/performance | M32.2–M32.9, M39.1–M39.7 |
| Security/privacy/transport | NFR Bảo mật; FR-13 Device auth; DoD 12 | M31.6, M34.8–M34.9, M39.5 |
| Protocol/client compatibility | NFR Sync compatibility | M31.4, M31.7, M34.2, M36.8, M37.8 |
| Initial-pairing throughput/progress without weaker safety | FR-13 plugin; NFR Sync performance | M42.1 |
| Publication and stable release | DoD 14 | M36.9–M36.10, M40.1–M40.6 |

FR-13 is complete only when every phase-40 stable gate and PRD DoD 8–14 has fresh evidence. A passing server
unit suite alone, a Markdown-only preview, a desktop-only plugin, or a plan without published/verified clients is
not completion. Each checked milestone requires the command, test, artifact, screenshot where UI applies, or
release URL recorded in the progress journal. Failed validation is triaged and fixed; it is not converted into a
scope exception without a PRD revision.

## 18. Authoritative references

Product and repository:

- [`PRD.md`](../PRD.md), especially FR-4, FR-13, NFRs, API/data model, risks, and DoD 8–14.
- [`sync/openapi-v1.yaml`](sync/openapi-v1.yaml), generated
  [`sync/protocol-v1.schema.json`](sync/protocol-v1.schema.json), and
  [`sync/README.md`](sync/README.md) are the executable protocol artifacts; the live stable-gate audit is
  [`sync/ACCEPTANCE_EVIDENCE.md`](sync/ACCEPTANCE_EVIDENCE.md).
- [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), phases 31–40 and progress journal.
- Current mutation/watcher baseline: `server/src/routes/files.ts`, `server/src/routes/agent.ts`,
  `server/src/services/vault.ts`, `server/src/services/git.ts`, `server/src/index.ts`, `web/src/App.tsx`, and
  `web/src/lib/store.ts`.

Obsidian plugin publication/API constraints (re-verify before submission because policies can change):

- [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
- [Submission requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins)
- [Developer policies](https://docs.obsidian.md/Developer+policies)
- [Vault API](https://docs.obsidian.md/Plugins/Vault)
- [`requestUrl`](https://docs.obsidian.md/Reference/TypeScript+API/requestUrl)
- [Secret storage guide](https://docs.obsidian.md/Plugins/Guides/Secret+storage)
- [Official sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin)

If an external policy conflicts with this document at implementation time, update PRD/roadmap/plan first; do not
silently weaken mobile support, security, publication, or release requirements.

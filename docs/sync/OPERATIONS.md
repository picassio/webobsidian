# Central Sync Operations Runbook

Central Sync is the only live-vault writer when `settings.sync.enabled=true`. Git is backup/version history only.
Never repair a live vault with `git reset`, `git checkout`, direct copy, or an editor behind the coordinator.

## Routine checks

- `GET /api/sync/v1/health` (administrator session): authoritative sequence, derived-index lag, device lag,
  operation outcomes/latency, transfer deduplication, drift repairs, and threshold alerts.
- `GET /api/sync/v1/metrics`: Prometheus 0.0.4 exposition. Alert immediately on
  `webobsidian_sync_read_only == 1`; investigate sustained index lag over 100 or device lag over 1,000.
- `GET /api/sync/v1/doctor`: non-mutating journal/checksum/revision/blob/filesystem validation.
- CLI: `web-vault-sync status` and `web-vault-sync doctor` (exit `0` healthy, `3` offline, `4` conflict,
  `5` recovery/state error).

Do not publish health/metrics/doctor without the normal administrator authentication boundary. Diagnostic exports
must not contain tokens, pairing codes, content, absolute paths, or remote URLs with credentials.

## Existing-vault migration

1. Stop external writers and resolve every unfinished Git merge/conflict. Do not force-reset.
2. In **Git Backup & Version History**, preview/apply remote content explicitly if it is needed. Imports clone to a
   temporary directory, show a plan, and apply through normal coordinator revisions only after confirmation.
3. Run **Migrate to Central Sync**. It creates a full local commit and pushes when a remote exists. Local-only
   continuation requires a separate explicit confirmation. A failed push leaves Central Sync disabled.
4. Verify the pre-migration commit/remote, then pair browser/plugin/headless devices.
5. Keep legacy bidirectional Git disabled permanently. Pull/clone return `409` while Central Sync is authoritative.

## Back up

Take a crash-consistent backup while the service is stopped (preferred), or snapshot both volumes atomically:

- the complete vault, including `.trash` and `.git` if used;
- the complete `data/sync/` tree (identity, journal, transactions, revisions, blobs, bases, conflicts, devices);
- `data/settings.json` and the deployment's secret material/credential store.

Git alone is not a Central Sync recovery backup: it does not contain device acknowledgements, journal history,
conflict metadata, trash metadata, or pending transaction intents.

## Restore vault plus sync metadata

1. Stop the server and every client. Preserve the failed volumes read-only for forensics.
2. Restore vault and `data/sync/` from the same snapshot generation; restore settings/secrets with restrictive modes.
3. Start one server only. It validates checksums, replays WAL intents, and either becomes healthy or enters read-only
   mode. Never delete a transaction intent merely to make startup pass.
4. Run sync doctor. Compare the latest sequence and sampled SHA-256 values with backup records.
5. Start one client, verify catch-up and acknowledgement, then release the remaining clients gradually.

## Rebuild metadata from a vault-only backup

Use only when no matching `data/sync` backup exists. This creates a new synchronization history and identity:

1. Stop all clients; archive the old `data/sync` and all client state/credentials.
2. Verify and independently back up the restored vault bytes.
3. Start with a new empty sync data directory and let bootstrap hash/index the vault. Bootstrap does not modify vault
   content. Run doctor and inspect case-fold/path exclusions before enabling writers.
4. Revoke/forget all old devices. Pair every device as new and perform a manifest bootstrap. Never reuse old cursors.

## Read-only recovery / journal or checksum corruption

- Keep the server in degraded read-only mode; reads and diagnostics remain available, writes must fail closed.
- Capture `health`, doctor output, logs, and immutable copies of the affected segment/store and its `.bak` file.
- Restore a matching crash-consistent backup. Do not hand-edit checksums or splice sequence numbers.
- If no backup exists, retain evidence and use the vault-only rebuild procedure; treat this as new history.

## Disk full or permission failure

1. Stop writers and free space outside the vault/sync directories. Do not remove WAL, blobs, bases, or journal files.
2. Restore owner-only permissions for credentials/state and the deployment user for vault/data directories.
3. Restart; WAL recovery deterministically rolls back unmaterialized work or finishes journal-committed work.
4. Run doctor and verify no sequence gap before reconnecting clients.

## Lost or compromised device

Revoke it in **Central Sync → Paired devices** immediately. Revocation invalidates bearer and browser-cookie credentials
on their next request. Rotate server/session secrets if broader compromise is suspected. A new pairing must use a
new random device identity; never copy credentials between devices or put them inside a vault.

## Cursor expiry and safe client reset

A `410 cursor_expired` is not corruption. The client must fetch one immutable paginated manifest, durably materialize
it, then resume ordered changes and acknowledge only after successful local application.

Before `web-vault-sync reset`, preserve unpushed local files/queue. Pull-only mode quarantines local-only files rather
than deleting them. After reset, pair/bootstrap as a new device. Never advance a cursor manually.

## Conflict response

Conflicts are durable records/copies, not errors to hide. Compare base/server/client, choose keep-server,
keep-client, merged, or copy, and let resolution create a normal revision event. Binary files are never text-merged.
Resolve before decommissioning the last device that owns needed local bytes.

# Multiple vaults

WebObsidian can host multiple isolated vaults concurrently in one server process.

## Isolation model

Each registered vault has its own:

- filesystem root and stable `vaultId`;
- SyncCoordinator, revision projection, ordered journal and tombstones;
- pairing codes, devices, token hashes and acknowledgements;
- uploads, blobs, retained bases, conflicts and maintenance boundary;
- filesystem watcher, QMD/link/file indexes;
- Git backup configuration and serialized Git queue;
- plugin enablement, public shares and browser workspace/IndexedDB state.

The login password/session and global UI/search tuning are shared by the single owner. A sync device credential is
bound to exactly one vault. A token for vault A cannot use a caller-supplied header to reach vault B.

## Web and Agent API selection

Authenticated vault-scoped APIs accept:

```http
X-WebObsidian-Vault-Id: vault_...
```

If omitted, the current default vault is used for backward compatibility. Agent API keys created after upgrading are
bound to the selected vault; migrated keys are bound to the migrated default vault. Browser deep links use:

```text
/vault/<vaultId>/note/<path>
/vault/<vaultId>/graph
```

Legacy `/note/<path>` and `/graph` links select the default vault.

Vault registry endpoints:

```text
GET    /api/vaults
POST   /api/vaults                  { name, path }
PATCH  /api/vaults/:vaultId         { name } or { default: true }
DELETE /api/vaults/:vaultId         { confirm: vaultId }
```

Registration requires an existing non-symlink directory inside the server allowlist. Registered roots cannot be equal,
nested or ancestors of one another. Unregistering never deletes vault files or runtime metadata. The detached record is
retained so registering the same real path again restores its original `vaultId`, devices and journal.

## Sync clients

Sync Protocol 1.0 and client commands are unchanged. Create a pairing code while the intended vault is active, then
pair the plugin/headless client normally. The pairing code and resulting token choose the vault.

Use a one-to-one mapping: one local Obsidian vault is a replica of one registered server vault. An installed plugin does
not register the local directory as a new server vault automatically. Register and select an isolated server vault before
pairing each unrelated local vault; pairing unrelated local directories to the same server vault intentionally converges
them into one namespace and is not a multi-vault workflow.

A headless profile remains one-vault-only. Use a separate config directory and systemd unit instance per local vault:

```ini
# /etc/systemd/system/web-vault-sync@.service
[Service]
ExecStart=/usr/bin/web-vault-sync --config-dir /etc/web-vault-sync/%i watch
```

For example, `web-vault-sync@work.service` and `web-vault-sync@personal.service` have distinct vault paths, state,
locks and credentials. Never point one profile at multiple directories.

## Settings and data migration

Settings v3 migrates atomically to v4. The existing vault becomes the `legacy` storage record and keeps all bytes in
place:

```text
data/sync/
data/qmd-index.json
data/shares.json
data/uistate.json
```

Additional vaults use:

```text
data/vaults/<vaultId>/sync/
data/vaults/<vaultId>/qmd-index.json
data/vaults/<vaultId>/shares.json
data/vaults/<vaultId>/uistate.json
```

Changing which vault is the default does not move either namespace. Migration writes an immutable mode-0600
`settings.v3.pre-v4.json`; `settings.json.bak` remains the rotating previous-write backup. A rollback must restore a
compatible application build and the immutable pre-v4 settings backup together. Always back up the vault roots and
entire data directory before an upgrade.

## Operations

- `/healthz` and authenticated `GET /api/vaults` report every registered runtime's health; `/healthz` fails if any runtime is read-only.
- Central Sync health, doctor, devices, conflicts and metrics are scoped to the selected vault.
- A newly registered non-empty vault starts `backup-required`; complete the backup migration before issuing pairing codes.
- Compose uses a managed data volume by default. Set `DATA_HOST_PATH` to a backup-visible host directory when host-level
  snapshots are required, and verify the live container's `/data`, `/vault`, and `/vaults` mount sources before resuming clients.
- Unregistering the default or final active vault is rejected.
- Unregistration marks the target runtime draining, refuses new request leases, disconnects sync sockets, waits for accepted
  HTTP work, stops the watcher/Git timer, flushes the coordinator projection and then detaches the registry entry. A drain
  timeout fails without detaching files or metadata.

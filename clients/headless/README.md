# web-vault-sync

Linux CLI and long-running filesystem daemon for WebObsidian Central Sync Protocol 1.0. The package uses the same `@webobsidian/sync-core` ordered client as the browser and native plugin.

> `0.1.x` is pre-release. npm/container publication occurs after the complete cross-client recovery matrix.

## Safety

- Checksummed, fsynced, atomic mode-0600 state outside the vault.
- Token from a mode-0600 file, `WEB_VAULT_SYNC_TOKEN`, or systemd `LoadCredential=sync-token`; never stored in state or logs.
- Durable path markers, blob-reference operation queue, apply intents, monotonic client sequence, and cursor-after-local-fsync.
- SHA-256/size verification before atomic rename; symlink, traversal, internal, Unicode, and case-fold guards.
- Fixed 8 MiB upload chunks and streamed downloads: attachment size does not become process memory size.
- Expected path/hash/revision echo suppression and per-profile single-daemon lock.
- Local drift in pull-only mode is quarantined under `.web-vault-sync-quarantine/`, never deleted silently.

## Install and pair

```bash
npm install -g web-vault-sync
web-vault-sync init \
  --server https://vault.example.com \
  --vault /srv/notes \
  --mode bidirectional

# Create a one-use code in WebObsidian Settings → Central Sync.
web-vault-sync pair --code 'pair_...'
web-vault-sync sync
web-vault-sync watch
```

Use `--profile NAME` for multiple vaults or `--config-dir PATH` for explicit state placement. `--json` gives stable machine-readable output. `web-vault-sync completion bash` prints shell completion.

## Commands

| Command | Purpose |
|---|---|
| `init` | Create state and validate HTTPS/vault/config placement. |
| `pair` | Exchange a one-use code and save the dedicated device token. |
| `sync` | One durable bidirectional cycle. |
| `pull` / `push` | One-shot mode override; configured daemon mode is unchanged. |
| `watch [--polling]` | Native watcher daemon or polling fallback. |
| `status --json` | Local queue/cursor and server reachability. |
| `conflicts list/show/resolve` | Inspect and resolve with server/client/copy/merged choices. |
| `doctor --json` | Verify permissions, checksum, paths/hashes, protocol, server, and token. |
| `reset --yes` | Reset local metadata while retaining every vault file. |

Exit codes: `0` success, `2` usage, `3` authentication, `4` unresolved conflict, `5` network/protocol transport, `6` local state/doctor failure, `7` daemon lock.

## Modes

- `bidirectional`: durable local push first, then ordered pull. Stale writes use the server merge/conflict matrix.
- `pull-only`: never pushes local changes; quarantines drift and restores the authoritative revision.
- `push-only`: pushes local content and consumes remote metadata/conflicts without applying remote bytes locally.

## systemd

1. Install the npm package globally.
2. Create a dedicated account: `useradd --system --home /var/lib/web-vault-sync --shell /usr/sbin/nologin web-vault-sync`.
3. Install `packaging/systemd/web-vault-sync.service`.
4. Initialize as that user with `--config-dir /var/lib/web-vault-sync`.
5. Save the token at `/etc/web-vault-sync/token` mode `0600`, add a service drop-in with `ReadWritePaths=/absolute/vault/path`, then run:

```bash
systemctl daemon-reload
systemctl enable --now web-vault-sync
systemctl status web-vault-sync
sudo -u web-vault-sync web-vault-sync --config-dir /var/lib/web-vault-sync doctor --json
```

The unit intentionally uses `Type=simple`; it does not claim `sd_notify` watchdog support.

## Docker

Build from the repository root so workspace dependencies are available:

```bash
docker build -f clients/headless/Dockerfile -t web-vault-sync:0.1.0 .
docker run --rm \
  -v web-vault-sync-config:/config \
  -v /srv/notes:/vault \
  web-vault-sync:0.1.0 init --server https://vault.example.com --vault /vault
```

The image is non-root and architecture-neutral. CI publishes the same Dockerfile for `linux/amd64` and `linux/arm64` only after both smoke tests pass.

## Scope and privacy

Normal vault files, attachments, and empty folders synchronize. `.obsidian/**`, `.git/**`, `.trash/**`, `.web-vault-sync-quarantine/**`, OS/editor temporary files, and state are excluded. The client connects only to the configured server, has no telemetry, and redacts bearer credentials from errors/logs.

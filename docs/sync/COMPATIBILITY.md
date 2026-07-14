# Central Sync Compatibility, Upgrade, and Support

## Protocol matrix

| Component | Release line | Protocol | Supported runtime/platform | Status |
|---|---:|---:|---|---|
| WebObsidian server/browser | 0.1.x | 1.0 | Node 20/22; current Chromium/Firefox/Safari | Local stable gates passing; public stable release pending. |
| `central-vault-sync` | 0.1.14 | 1.0 | Obsidian ≥1.11.4 desktop/mobile | Normal public Community-review release. It adds popout-compatible `activeDocument`/`activeWindow` foreground handling over 0.1.13; core sync behavior otherwise retains the exact 0.1.12 implementation that passed deployed pair/push/pull, Markdown/binary, immediate rename→modify, delete, outage/offline hard restart/retry, and unsaved-open-editor conflict preservation on real Linux Obsidian 1.12.7. Community acceptance and other OS/mobile matrix pending. |
| `web-vault-sync` | 0.1.0 | 1.0 | Node ≥20; Linux primary; macOS validation pending | Public npm package; registry-origin Linux pair/sync/status/doctor, systemd boot, reinstall, and healthy source-built sidecar verified. Registry image publication intentionally not offered. |
| `@picassio/sync-core` | 0.1.3 | 1.0 | Platform-neutral ESM | Public npm package; durable enqueue-before-publish and flush-before-pull wake/poll ordering are regression-tested; clean registry-origin ESM import and zero-vulnerability dependency install verified. |

The handshake is authoritative. Major protocol mismatch returns 426 and no mutation. Within Protocol 1.x, additions
must be optional/capability-negotiated and the server supports the current and immediately previous released minor
during a rolling upgrade. Protocol 1.0 has no earlier minor to retain. Never add a silent fallback that guesses an
existing entry's revision. Multi-vault routing is server-side and additive: a paired Protocol 1.0 token selects its
bound vault, so plugin/headless request shapes do not change.

## Safe upgrade order

1. Back up every vault root and the complete data directory (`data/sync` and `data/vaults/*`) from the same generation; run doctor and clear unresolved recovery alerts.
2. Upgrade the server first within a compatible protocol line. Verify health, journal sequence, Git backup status,
   and one browser catch-up before releasing all clients.
3. Upgrade native/headless clients gradually. An older compatible client may continue; an incompatible client must
   pause with diagnostics rather than reset or overwrite.
4. Re-run a create/modify/rename/delete/attachment/conflict smoke and compare acknowledgements.

Settings v3→v4 preserves the original vault identity/data in place and adds isolated namespaces for later vaults;
see [Multiple vaults](../MULTI_VAULT.md). For the first Central Sync migration, follow `OPERATIONS.md`: existing vaults remain `backup-required`, pairing is
blocked, and the assistant commits/pushes a full backup before switching Git to backup-only.

## Rollback

- **Client rollback:** stop the client, preserve its queue/state and local-only bytes, install the previous compatible
  build, and restart. Do not edit the cursor. If state schema is rejected, archive it and pair as a new device only
  after preserving unsent work.
- **Server rollback:** stop all writers and restore server binary, vault, and `data/sync` from one pre-upgrade
  snapshot. Never run an older binary against metadata it does not declare compatible and never restore Git alone.
- A vault-only rebuild is a new history/vault identity and requires every device to re-pair/bootstrap.

## Windows

- **Recommended today:** use the native `central-vault-sync` plugin inside Windows Obsidian. It uses platform-neutral
  Obsidian APIs, but Windows remains prerelease/unverified until the copied-vault lifecycle matrix passes on real NTFS.
- Pair over trusted HTTPS while the intended WebObsidian vault is selected. The resulting credential is bound to that
  vault. Never run the plugin and a headless client against the same local folder.
- Native Windows `web-vault-sync` is not yet supported: current 0.1.x headless storage enforces POSIX `0700`/`0600`
  modes, directory fsync semantics, and systemd packaging. Windows support requires DPAPI or validated user-only ACL
  token storage, atomic-replace sharing-violation retries, reserved-name/trailing-dot/junction/case policy, `%LOCALAPPDATA%`
  profiles, Windows service packaging, `windows-latest` CI, and real NTFS watcher/recovery evidence.
- WSL2 can be used as a temporary headless workaround. Prefer a vault on WSL ext4; for `/mnt/c`, use
  `web-vault-sync watch --polling` and validate case-only rename/watcher behavior. WSL evidence does not count as native
  Windows acceptance.

## Native mobile limitations

- Mobile synchronization runs on plugin load, app foreground/resume, manual Sync now, and bounded foreground
  retries. iOS/Android may suspend background networking; continuous background sync is not promised.
- Large catch-ups yield in bounded batches. Keep the app foregrounded until status is Synced before closing it.
- The plugin uses Obsidian `Vault`, `requestUrl`, and `SecretStorage`; no Node filesystem or Electron API is required.
  SecretStorage encryption depends on a functioning platform keychain. Obsidian warns and may fall back to
  unencrypted local storage when none exists; configure a keychain on shared/untrusted systems.
- `.obsidian/**`, workspace/layout, `.git/**`, `.trash/**`, temporary files, and sync metadata are excluded in v1.

## Privacy and telemetry

Central Sync has no telemetry service. Vault content and credentials go only between the configured self-hosted
server and paired clients. Health/diagnostic exports contain sequence/lag/counts and redacted errors, never note
content, raw tokens, pairing codes, credential-bearing URLs, or absolute paths. Git remotes receive backups only
when explicitly configured by the operator.

## Troubleshooting

1. Check HTTPS/server URL and clock, then run server health/doctor and client status/doctor.
2. `401/403`: pair again or inspect revocation; never copy another device's token.
3. `409`: preserve the local draft and resolve the durable conflict; do not retry with a guessed base revision.
4. `410 cursor_expired`: allow immutable manifest bootstrap; do not manually advance the cursor.
5. Read-only health: stop writers and follow corruption/restore procedures in `OPERATIONS.md`.
6. Mobile not caught up: foreground Obsidian, run Sync now, and keep it open until Synced.
7. Include redacted diagnostics, versions, protocol, platform, and reproduction steps in support reports.

Security issues must be reported privately according to the root `SECURITY.md` and plugin `SECURITY.md`, not in a
public issue. General issues: <https://github.com/picassio/webobsidian/issues>; native plugin issues:
<https://github.com/picassio/central-vault-sync/issues>.

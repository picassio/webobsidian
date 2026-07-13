# Central Sync Compatibility, Upgrade, and Support

## Protocol matrix

| Component | Release line | Protocol | Supported runtime/platform | Status |
|---|---:|---:|---|---|
| WebObsidian server/browser | 0.1.x | 1.0 | Node 20/22; current Chromium/Firefox/Safari | Local stable gates passing; public stable release pending. |
| `central-vault-sync` | 0.1.8 | 1.0 | Obsidian ≥1.11.4 desktop/mobile | Public prerelease; real Linux Obsidian 1.12.7 pair/push/pull, concurrent attachments, rename/delete, offline cold start/hard restart/retry, pause deferral, and unsaved-open-editor conflict preservation verified; Community acceptance and other OS/mobile matrix pending. |
| `web-vault-sync` | 0.1.x | 1.0 | Node ≥20; Linux primary; macOS validation pending | npm publication pending; local amd64/arm64 source image verified, registry publication intentionally not offered. |
| `@webobsidian/sync-core` | 0.1.x | 1.0 | Platform-neutral ESM | npm publication pending. |

The handshake is authoritative. Major protocol mismatch returns 426 and no mutation. Within Protocol 1.x, additions
must be optional/capability-negotiated and the server supports the current and immediately previous released minor
during a rolling upgrade. Protocol 1.0 has no earlier minor to retain. Never add a silent fallback that guesses an
existing entry's revision.

## Safe upgrade order

1. Back up the vault and `data/sync` from the same generation; run doctor and clear unresolved recovery alerts.
2. Upgrade the server first within a compatible protocol line. Verify health, journal sequence, Git backup status,
   and one browser catch-up before releasing all clients.
3. Upgrade native/headless clients gradually. An older compatible client may continue; an incompatible client must
   pause with diagnostics rather than reset or overwrite.
4. Re-run a create/modify/rename/delete/attachment/conflict smoke and compare acknowledgements.

For the first Central Sync migration, follow `OPERATIONS.md`: existing vaults remain `backup-required`, pairing is
blocked, and the assistant commits/pushes a full backup before switching Git to backup-only.

## Rollback

- **Client rollback:** stop the client, preserve its queue/state and local-only bytes, install the previous compatible
  build, and restart. Do not edit the cursor. If state schema is rejected, archive it and pair as a new device only
  after preserving unsent work.
- **Server rollback:** stop all writers and restore server binary, vault, and `data/sync` from one pre-upgrade
  snapshot. Never run an older binary against metadata it does not declare compatible and never restore Git alone.
- A vault-only rebuild is a new history/vault identity and requires every device to re-pair/bootstrap.

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

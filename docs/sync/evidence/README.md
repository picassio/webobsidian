# Validation evidence

## `obsidian-linux-1.12.7-plugin-0.1.12-release.png`

Exact public `central-vault-sync` 0.1.12 assets were downloaded from the tagged release and matched the release API
SHA-256 digests: `d5fe3682…bd81` (`main.js`), `effc4d35…bb4d` (`manifest.json`), and
`4759b965…b4d` (`styles.css`). The screenshot shows the exact build loaded in real Obsidian Linux 1.12.7 and the
synchronized status after deployed-server testing. The visible SecretStorage warning is expected on this disposable
Xvfb host without a desktop keychain; the token remained absent from plugin data, logs, diagnostics, and the vault.

Real use first reproduced a wake/local-echo race in 0.1.10 and a narrower immediate rename→modify echo race in the
superseded 0.1.11 draft. Public 0.1.12 uses `@picassio/sync-core@0.1.3`: local operations are durably staged before
path markers clear and before publication, wake/poll catch-up flushes local operations first, matching echoes avoid
rewrites, and an already-materialized rename advances metadata without replacing a later local destination edit.
Core/plugin regressions cover each boundary.

The exact-release deployed matrix proved one-use pairing and preserved paired state across upgrades; initial pull;
Markdown and six-byte binary create; immediate identity-preserving rename→modify; headless-authored remote pull;
Markdown/binary delete; endpoint outage with pending state, hard app termination, offline cold start, and recovery;
and an overlapping remote update while an open editor was unsaved. The latter retained the remote canonical file and
an exact local conflict copy, then resolved cleanly. Final diagnostics reached cursor 59 with zero conflicts, queue,
pending paths, apply intents, or errors. Both registry-origin headless clients passed doctor; disposable active files
were removed and every test device was revoked. Windows, macOS, Android, iOS, independent beta, and Community
acceptance remain separate external gates.

## `obsidian-linux-1.12.7-plugin-0.1.9-release.png`

The event-burst candidate loaded in real Obsidian Linux 1.12.7 is byte-identical to public
`central-vault-sync` 0.1.9: SHA-256 `c2e653b6…4eed` (`main.js`), `ca27ef9c…d373` (`manifest.json`), and
`4759b965…b4d` (`styles.css`). The screenshot shows version 0.1.9 enabled and synchronized.

Queue review found that a rename marker and a rapid modify shared the destination path; replacing the former with
the latter could create the destination as a new identity while leaving the old server path. A modify marker for
the old path could also disappear after the local rename. Version 0.1.9 durably coalesces destination events,
commits an identity-preserving rename first, and always rehashes the destination using either the new projection or
the prior identity/base. Rename immediately followed by delete collapses safely to deletion of the original
identity rather than a stale rename/delete conflict. Unit regressions cover both burst forms.

In the exact-byte Obsidian drill, `Burst.md` was synchronously renamed to `Final.md` and modified before the debounce
elapsed. The authoritative journal appended sequence 12 `rename` then sequence 13 `modify`; both retained entry ID
`entry_8KBpvgDn-wjEAn_NF8ILtfF2`, revisions advanced 9→10→11, `Burst.md` disappeared, and local/server
`Final.md` matched `final burst content`. Cursor reached 13, next client sequence 10, with zero conflicts,
queue, pending paths, or apply intents. Prior evidence below remains applicable.

## `obsidian-linux-1.12.7-plugin-0.1.8-release.png`

The authoritative-conflict-status candidate loaded in real Obsidian Linux 1.12.7 is byte-identical to public
`central-vault-sync` 0.1.8: SHA-256 `7a3db095…49c0` (`main.js`), `d5905427…faaa` (`manifest.json`), and
`4759b965…b4d` (`styles.css`). The screenshot shows version 0.1.8 enabled and synchronized.

Restarting 0.1.7 over two durable unresolved server conflicts exposed a status defect: diagnostics and the status
bar reset to zero because the count existed only in memory, even though the conflict modal still listed both.
Version 0.1.8 refreshes the count from the authenticated authoritative conflict endpoint after startup, every
successful synchronization, and each modal resolution. In the exact-byte drill, restart restored **2 conflicts**
while synchronized at cursor 7. Resolving the first through **Keep server** advanced cursor/client sequence and
immediately changed the badge to **1 conflict**; restarting exact 0.1.8 restored that count. Resolving the final
record updated the modal to **No unresolved conflicts**, advanced cursor to 9, and removed the badge with zero
queue/pending/apply intents. Prior 0.1.7 startup-scaling and 0.1.6 editor-safety evidence remains applicable.

## `obsidian-linux-1.12.7-plugin-0.1.7-release.png`

The startup-reconciliation candidate loaded in real Obsidian Linux 1.12.7 is byte-identical to public
`central-vault-sync` 0.1.7: SHA-256 `29d98721…983e` (`main.js`), `03676a1b…a790` (`manifest.json`), and
`4759b965…b4d` (`styles.css`). The screenshot shows version 0.1.7 enabled and synchronized.

A pre-submission load-time audit found that each startup path previously created and removed a durable pending
marker even when its projected hash/kind was unchanged. Because every marker save serializes plugin state, a large
vault caused two full-state writes per unchanged path; path and entry-ID lookup also linearly scanned the complete
projection. Version 0.1.7 adds in-memory path/ID/position indexes, updates them through rename/tombstone replacement,
hashes unchanged files without persisting markers or allocating client sequences, and yields to the Obsidian UI
every 100 paths. A 10,000-entry regression proves lookups do not call the projection array's linear `find`, preserve
exactly 10,000 entries through rename/tombstone updates, and pass under all supported Node test versions.

The exact-byte Obsidian reconnect over the already converged three-file matrix was instrumented at `Plugin.saveData`:
it completed synchronized at cursor 7, next client sequence 4, with zero queue/pending/apply intents and **zero
plugin-data writes** for unchanged reconciliation. The 0.1.6 editor-safety evidence below remains applicable.

## `obsidian-linux-1.12.7-plugin-0.1.6-release.png`

The open-editor safety candidate loaded in real Obsidian Linux 1.12.7 is byte-identical to public
`central-vault-sync` 0.1.6: SHA-256 `9a498bb9…41f2` (`main.js`), `66330b11…849a` (`manifest.json`), and
`4759b965…b4d` (`styles.css`). The screenshot shows version 0.1.6 enabled and synchronized after the conflict drill.

A baseline note was opened in Obsidian's Markdown editor. Its editor buffer was changed to
`local protected 0.1.6` and, before Obsidian persisted that buffer, a web writer committed overlapping
`remote 0.1.6` at the observed base revision. Release 0.1.5 reproduced a critical defect in this exact race: remote
Vault application replaced the editor buffer within 150 ms and the pending marker then hashed the remote bytes,
silently losing the local text. The 0.1.6 adapter instead checks durable pending/queued work and every affected
open Markdown editor against disk before remote replacement, rename, or deletion. Startup synchronization also
waits for workspace layout restoration so those editors are visible during apply-intent recovery.

In the repeated exact-byte drill, the remote event remained as a durable apply intent at cursor 5 while the editor
still contained the local text and disk retained the prior canonical bytes. Obsidian then persisted the local edit;
the normal stale-base operation produced a server conflict-copy event. Catch-up converged at cursor 7 with zero
pending operations/apply intents: canonical `Open.md` contained `remote 0.1.6`, while the local and server conflict
copy both contained `local protected 0.1.6` with SHA-256 `04d264a7…6cf`. A separate pause drill proved the cursor
and disk remain unchanged while paused and apply exactly after resume. This closes the Linux evidence behind the
M36.5 “file đang mở” claim; unavailable platforms and Community acceptance remain open.

## `obsidian-linux-1.12.7-plugin-0.1.5-release.png`

The final runtime-outage candidate loaded in the same real Obsidian Linux 1.12.7 matrix is byte-identical to public
`central-vault-sync` 0.1.5: SHA-256 `08f7e3c3…df6e` (`main.js`), `f094631b…80c2` (`manifest.json`), and
`4759b965…b4d` (`styles.css`). The screenshot shows version 0.1.5 enabled and **Central Sync: synced**.

With the app already foregrounded and synchronized at cursor 12, the server was stopped and a binary attachment
was created through Obsidian's Vault API. Without manual **Sync now** or an app restart, the plugin reported
**offline**, retained one pending marker, preserved the next client sequence, and stored only the redacted
connection error. After the server returned, the scheduled retry uploaded the exact five bytes and converged at
cursor 13/next client sequence 28 with `lastError` cleared and zero conflicts, queued operations, pending paths, or
apply intents. Local/server SHA-256 both equal `0835f545…3d8`. This specifically closes the runtime-event retry gap
found during the Community-guideline preflight; the broader 0.1.4 lifecycle matrix below remains applicable.

## `obsidian-linux-1.12.7-plugin-0.1.4-release.png`

The final binary loaded in an isolated real Obsidian Linux 1.12.7 vault is byte-identical to the public
`central-vault-sync` 0.1.4 release assets. Release/API SHA-256 values are `fc64bd36…4e2` (`main.js`),
`02347da5…9f6` (`manifest.json`), and `4759b965…b4d` (`styles.css`). The screenshot shows the exact 0.1.4 plugin
enabled and **Central Sync: synced**.

The copied-vault matrix used a fresh production WebObsidian server and proved:

- one-use pairing without a token in plugin `data.json`;
- simultaneous folder, Markdown, and binary creation without client-sequence overtaking;
- Markdown modification, identity-preserving rename, and attachment deletion;
- a server outage followed by an offline Markdown change and binary create, durable pending state, hard Obsidian
  termination, restart, and exact convergence;
- a second cold start while the server remained unavailable: the plugin stayed loaded with **offline** status,
  persisted pending paths and a redacted connection error, then retried automatically and converged after the
  server returned without a manual click;
- concurrent 2 MiB and 1-byte attachment uploads through the final queue implementation, with exactly two client
  sequences consumed and byte-identical local/server SHA-256 values; and
- one gapless authoritative journal of 12 events, ending at cursor 12 with zero conflicts, queued operations,
  pending paths, or apply intents.

This closes the Linux attachment/rename/delete/interruption portion of M36.8. Windows, macOS, Android, iOS,
independent testing, and Community acceptance remain separate open gates.

## `obsidian-linux-1.12.7-plugin-0.1.2-release.png`

Exact public GitHub release assets (`main.js`, `manifest.json`, and `styles.css`) for `central-vault-sync` 0.1.2
were downloaded and their SHA-256 values matched the release API digests. They were installed into a fresh isolated
Obsidian Linux 1.12.7 vault—not rebuilt locally. The screenshot shows version 0.1.2 enabled and **Central Sync:
synced** after one-use pairing, a Vault-created note reaching the server as device sequence 1, and a web-authored
revision returning through the plugin with cursor 2, no remaining apply intent/queue, and no token in plugin data.

## `obsidian-linux-1.12.7-plugin.png`

Real Obsidian Linux 1.12.7 running `central-vault-sync` 0.1.1 after:

- public release assets installed into an isolated vault;
- plugin trust/enable and legacy-compatible settings rendering;
- pairing to a production WebObsidian Protocol 1.0 server;
- local Vault event pushed as a device-authored revision;
- remote revision applied through the Vault API;
- server outage, durable offline path state, hard app termination, restart, and queue/cursor convergence.

The status bar shows **Central Sync: synced** and the recovered files. The visible Obsidian notification is also
intentional evidence of a platform condition: this disposable Xvfb host had no desktop keychain, so Obsidian
warned that SecretStorage used an unencrypted fallback. The plugin never writes the token to `data.json`, logs,
diagnostics, or the vault, but SecretStorage encryption at rest depends on a configured operating-system keychain;
this limitation is disclosed in plugin/root security and compatibility documentation.

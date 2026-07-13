# Validation evidence

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

# Validation evidence

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

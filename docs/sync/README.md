# Sync Protocol Artifacts

These files implement the contract in [`../SYNC_ROADMAP.md`](../SYNC_ROADMAP.md):

- `openapi-v1.yaml` — OpenAPI 3.1 endpoint/auth contract.
- `protocol-v1.schema.json` — generated JSON Schema definitions.
- `../../packages/sync-core/src/schemas.ts` — authoritative runtime Zod schemas and TypeScript types.
- `../../packages/sync-core/fixtures/protocol-v1.json` — publishable golden conformance transcript.
- `../../packages/sync-core/src/sync-client.ts` — shared ordered manifest/catch-up/apply-intent/offline-queue
  state machine used by browser, native plugin, and headless adapters.
- [`OPERATIONS.md`](OPERATIONS.md) — migration, monitoring, backup/restore, corruption, disk-full,
  revocation, cursor-expiry, reset, and conflict-response runbooks.
- [`SCALABILITY.md`](SCALABILITY.md) — reference hardware/results, JSON journal/projection review, tuning,
  and explicit capacity stop conditions.
- [`COMPATIBILITY.md`](COMPATIBILITY.md) — rolling upgrade matrix/policy, rollback, mobile limits, privacy,
  troubleshooting, and support/security channels.
- [`../MULTI_VAULT.md`](../MULTI_VAULT.md) — vault registry, isolation, API selection, migration and systemd profiles.
- [`ACCEPTANCE_EVIDENCE.md`](ACCEPTANCE_EVIDENCE.md) — explicit PRD DoD 8–14 and phase 31–41 evidence map,
  remaining external blockers, and the stable completion rule.

Current consumers:

- Browser adapter: `web/src/lib/browser-sync-*.ts` (IndexedDB strict-durability state; device credential is
  an httpOnly SameSite=Strict cookie and never enters JavaScript/IndexedDB; legacy IndexedDB credentials are
  one-time rotated server-side before deletion).
- Native plugin Community-review release: [picassio/central-vault-sync](https://github.com/picassio/central-vault-sync)
  (Vault API + `requestUrl` + SecretStorage; source public, Community Plugins review pending).
- Headless adapter: public `web-vault-sync@0.1.0` under `clients/headless/`; a source patch serializes watcher
  drains and adds multi-vault systemd profile units, but that patch is not yet published.

Regenerate and verify:

```bash
npm --workspace @picassio/sync-core run generate:schema
npm --workspace @picassio/sync-core test
npx @redocly/cli lint docs/sync/openapi-v1.yaml
```

Do not edit `protocol-v1.schema.json` by hand. A protocol change must update runtime schemas, fixtures,
OpenAPI, roadmap/PRD when semantics change, and compatibility tests in the same change.

## Stable publication gate

Before pushing a stable `vX.Y.Z` tag, configure an npm publication token as the repository Actions secret
`NPM_TOKEN` and set the root, sync-core, and headless package versions to exactly `X.Y.Z`. The stable workflow
fails closed when the credential or version alignment is missing, runs both browser and two-headless-client E2E,
publishes both npm packages with provenance, and only then creates the immutable GitHub release. It does not
publish container images; operators clone the verified source tag and build the Dockerfiles locally.

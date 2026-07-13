# Central Sync stable-acceptance evidence

> Evidence snapshot: 2026-07-13 · WebObsidian implementation `3d27b5a` plus `@picassio` package-scope migration · plugin source/tag `e430b67`/`0.1.10` ·
> Protocol 1.0 · This file records evidence; it does not waive an open gate.

This is the explicit audit map for PRD FR-13, PRD Definition of Done (DoD) 8–14, and
`IMPLEMENTATION_PLAN.md` phases 31–40. **PASS** means the stated requirement has direct, current evidence.
**PARTIAL** means implementation evidence exists but a required platform/publication review is missing.
**BLOCKED** means an external prerequisite is unavailable. Stable release is forbidden while any row is not PASS.

The distribution policy in PRD 1.7 is authoritative: container images are not published to a registry. CI must
build/smoke both Dockerfiles for amd64/arm64 with SBOM/provenance, and operators clone an immutable source tag and
build locally.

## Current immutable/public evidence

| Evidence | Result |
|---|---|
| WebObsidian CI | [Run 29253428343](https://github.com/picassio/webobsidian/actions/runs/29253428343) on personal-scope commit `f51a16b`: 126 tests; typecheck/build; OpenAPI and Markdown links; dependency audit; production two-browser and two-headless-client E2E; systemd verification; attested amd64/arm64 source builds for server/headless; non-root smoke. The Docker job passed on attempt 3 after GitHub returned Service Unavailable before action download on attempts 1–2. |
| Native plugin release | [`central-vault-sync` 0.1.10](https://github.com/picassio/central-vault-sync/releases/tag/0.1.10), source/tag `e430b67`; release CI [29252583800](https://github.com/picassio/central-vault-sync/actions/runs/29252583800), plus Node 20/22/24 CI [29252582130](https://github.com/picassio/central-vault-sync/actions/runs/29252582130). It consumes public `@picassio/sync-core@0.1.2`; the vendored tarball was removed. |
| Real Obsidian Linux | [`evidence/obsidian-linux-1.12.7-plugin-0.1.9-release.png`](evidence/obsidian-linux-1.12.7-plugin-0.1.9-release.png) and its [evidence notes](evidence/README.md): exact public 0.1.9 bytes retain prior lifecycle/editor/performance/conflict evidence and prove immediate rename→modify commits ordered rename then modify on the same stable identity with exact final bytes. Plugin 0.1.10 changes only shared-package distribution and passes all plugin CI/policy/conformance gates. |
| Headless registry install/upgrade | Public `web-vault-sync@0.1.0` installed from npm with exact `@picassio/sync-core@0.1.2`; clean dependency audit passed. A dedicated-user registry-origin pair/sync/status/doctor reached cursor 1, the shipped hardened systemd unit reached active and pushed revision 2, source-built non-root sidecar reached Docker healthy and exited cleanly, and same-version unattended reinstall preserved external state/token hashes and restarted at cursor 2. Earlier packed pre-marker→current migration evidence also remains valid. |
| npm publication | [`@picassio/sync-core@0.1.2`](https://www.npmjs.com/package/@picassio/sync-core/v/0.1.2), SHA-1 `6ebe86f6…8120`, and [`web-vault-sync@0.1.0`](https://www.npmjs.com/package/web-vault-sync/v/0.1.0), SHA-1 `d9469c96…dd33`, are public. Registry-origin imports/bin/dependency tree and zero-vulnerability install were verified; repository `NPM_TOKEN` is configured from 1Password without exposing it. |

## PRD DoD 8–14 audit

| DoD | Status | Requirement and concrete evidence | Remaining evidence |
|---:|:---:|---|---|
| 8 | **PASS** | Two-browser concurrent/stale writes never silently overwrite. `e2e/browser-pair.mjs`, `web/test/store-save.test.ts`, `web/test/sync-engine.test.ts`, coordinator conflict tests, and CI run 29253428343 cover accepted writes, 409 retention, diff3, conflict copies, offline reload, apply-intent recovery, binary blobs, rename/delete, and hidden browser credentials. | None. |
| 9 | **PARTIAL** | Native desktop implementation: `central-vault-sync/src/main.ts`, `local-queue.ts`, `obsidian-adapter.ts`, `plugin-store.ts`; plugin tests/conformance pass. Exact 0.1.9 bytes on real Linux Obsidian 1.12.7 cover Markdown and binary attachments, modify, rename, delete, concurrent uploads, server outage, hard restart, offline cold start, automatic startup/runtime retry, pause deferral, and preservation of a racing unsaved open-editor change as an exact conflict copy. | Repeat the copied-vault desktop matrix on real Windows and macOS and retain diagnostics/results. Linux is complete, but unavailable platforms are required by M36.8/stable matrix. |
| 10 | **BLOCKED** | Foreground hooks (`visibilitychange`, `focus`, `active-leaf-change`), durable pending paths/operations/apply intents, bounded mobile large-file confirmation, and mobile-compatible Vault/request APIs are implemented. | Real Android and iOS foreground/suspend/hard-restart tests proving no pending-operation loss. No devices are available. |
| 11 | **PASS** | `clients/headless` implements one-shot modes, watch, status, doctor, conflicts, systemd, and non-root sidecar. Tests include 1 GiB bounded streaming, state/token permissions, daemon lock, unit contract, CLI exit paths; `e2e/headless-pair.mjs` covers two production-build CLI profiles. Real systemd lifecycle and native/emulated amd64/arm64 execution are recorded in the plan. | None for DoD 11. macOS remains a broader M37.8 compatibility gate. |
| 12 | **PASS** | Revocation, hashed tokens, idempotency/replay, rate limits, CSRF, traversal/symlink, blob hash/quota, exact protocol rejection, and WebSocket ticket tests live under `server/test`, core/browser/headless conformance suites, and plugin conformance tests. CI run 29253428343 is green. | None. |
| 13 | **PASS** | Central Sync hard-gates Git pull; coordinator events trigger backup-only commit/push; import preview/confirmed restore creates ordinary revisions. Evidence: `server/test/authority-guard.test.ts`, `import.test.ts`, `backup-restore-drill.test.ts`, migration tests, and `docs/sync/OPERATIONS.md`. | None. |
| 14 | **BLOCKED** | Plugin 0.1.10 is a public prerelease; `@picassio/sync-core@0.1.2` and `web-vault-sync@0.1.0` are public and registry-origin verified; Dockerfiles are reproducibly built/smoked for amd64/arm64 from source. | (1) Submit plugin to Obsidian Community Plugins, resolve review, install/update from the in-app directory. (2) Complete unavailable platform/independent beta gates. (3) Create the aligned stable tag and verify GitHub release checksums/SBOM/attestations plus npm provenance. |

## Phase 31–40 audit

| Phase | Status | Evidence summary |
|---:|:---:|---|
| 31 — contract/architecture | **PASS** | Protocol 1.0 Zod/types, generated JSON Schema/OpenAPI, fixtures, traceability, exact-version negotiation and conformance across all clients. See `packages/sync-core`, `docs/sync/openapi-v1.yaml`, and conformance tests. |
| 32 — metadata/journal/recovery | **PASS** | Checksummed segmented journal, WAL intents, atomic stores, CAS blobs, replay/retention, doctor, corruption/read-only and crash-boundary tests under `server/src/sync` and `server/test`. |
| 33 — mutation authority | **PASS** | `SyncCoordinator`, path/subtree locking, revision/base enforcement, deterministic merge/conflict copies, external reconciliation, derived retries, trash/restore; authority guard and coordinator/fault tests. |
| 34 — API/auth/blob | **PASS** | Pairing/revocation, immutable manifests, ordered changes/acks, resumable uploads, operation batches, health/metrics, HTTPS/CSRF/rate/path defenses, wake-only WebSocket. API/security/E2E tests pass. |
| 35 — browser | **PASS** | httpOnly device cookie, strict durable IndexedDB state, per-document generation-safe saves, offline queue/catch-up, conflict center, attachment transfer, and production two-browser E2E. |
| 36 — native plugin | **PARTIAL** | M36.1–M36.9 implementation/release work, public `@picassio/sync-core`, plugin 0.1.10, and the full real-Linux lifecycle/file-operation/editor-safety matrix are complete. | M36.7 mobile physical lifecycle, M36.8 Windows/macOS/mobile matrix, and M36.10 Community review remain open. |
| 37 — headless | **PARTIAL** | CLI/daemon, modes, watcher, conflict/doctor/reset, public npm package plus registry-origin systemd/sidecar/reinstall, two-client E2E, 1 GiB, installed-state upgrade and amd64/arm64 evidence complete. | Real macOS execution remains open. |
| 38 — Git transition | **PASS** | Backup-only authority, explicit import/restore, legacy hard gate, migration backup prerequisite, LFS separation, bounded retry and drills/tests. |
| 39 — hardening/operations | **PASS** | Existing-vault migration, 10k/50k/reconnect/1 GiB benchmarks, compaction/retention, crash/ENOSPC/corruption/skew/symlink tests, observability, and backup/recovery runbooks/drills. |
| 40 — release/support | **BLOCKED** | M40.1 technical preview and M40.5 public headless npm/registry-origin Linux systemd-sidecar validation are complete. Stable workflow has its npm credential, fails closed on version alignment, runs both E2Es, publishes npm with provenance, then creates the GitHub release. | Independent private-alpha evidence, public mobile/client matrix, Community acceptance, real unavailable platforms, aligned stable versions, and final stable tag are outstanding. |

## Exact external blockers and required access

1. **Obsidian Community submission:** authenticated owner submits
   [`picassio/central-vault-sync`](https://github.com/picassio/central-vault-sync), supplies the review PR URL, and
   permits reviewer-feedback fixes. Acceptance must be verified by in-app Community Plugins install/update.
2. **Physical platforms/testers:** copied non-production vaults on Windows, macOS, Android, and iOS, plus independent
   alpha/beta testers. Record app/OS versions and redacted results using plugin issue
   [#1](https://github.com/picassio/central-vault-sync/issues/1).
3. **Stable publication:** only after all preceding gates pass, align root/core/headless versions, push the
   stable source tag, and verify npm registry packages plus GitHub checksums, SBOM, and attestations. Do not publish
   registry container images.

## Completion rule

Do not mark FR-13 or the active implementation goal complete until every PARTIAL/BLOCKED row above is PASS and its
external URL, artifact digest, test output, screenshot, or review/install evidence has been added here and to
`IMPLEMENTATION_PLAN.md`.

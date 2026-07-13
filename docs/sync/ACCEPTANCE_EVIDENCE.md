# Central Sync stable-acceptance evidence

> Evidence snapshot: 2026-07-13 · WebObsidian implementation `3d27b5a` · plugin source/tag `a582605`/`0.1.4` ·
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
| WebObsidian CI | [Run 29240963980](https://github.com/picassio/webobsidian/actions/runs/29240963980): 126 tests; typecheck/build; OpenAPI and Markdown links; dependency audit; production two-browser and two-headless-client E2E; systemd verification; attested amd64/arm64 source builds for server/headless; non-root smoke. |
| Native plugin release | [`central-vault-sync` 0.1.4](https://github.com/picassio/central-vault-sync/releases/tag/0.1.4), source/tag `a582605`; release CI [29244294191](https://github.com/picassio/central-vault-sync/actions/runs/29244294191), plus Node 20/22/24 CI [29244292517](https://github.com/picassio/central-vault-sync/actions/runs/29244292517). |
| Real Obsidian Linux | [`evidence/obsidian-linux-1.12.7-plugin-0.1.4-release.png`](evidence/obsidian-linux-1.12.7-plugin-0.1.4-release.png) and its [evidence notes](evidence/README.md): exact public 0.1.4 bytes; simultaneous Markdown/binary creates; modify/rename/delete; outage plus hard restart; cold start while offline plus automatic retry; gapless 12-event journal; exact attachment hashes; zero conflict/queue/apply-intent residue. |
| Headless installed upgrade | Packed commit `4d45e88` (core 0.1.1/pre-marker state) was globally installed, paired, and synced; replacement with current core 0.1.2/headless bytes preserved credential/device/cursor/vault, migrated state, accepted the next revision, and passed doctor. Full command/result is recorded in the implementation-plan journal. |
| npm preflight | Authentication identifies `picassio`; clean public dry-runs: core 0.1.2 SHA-1 `d8710e09…`, headless 0.1.0 SHA-1 `f93d692e…`. Actual core publication returns `E404 Scope not found`; nothing was falsely marked published. |

## PRD DoD 8–14 audit

| DoD | Status | Requirement and concrete evidence | Remaining evidence |
|---:|:---:|---|---|
| 8 | **PASS** | Two-browser concurrent/stale writes never silently overwrite. `e2e/browser-pair.mjs`, `web/test/store-save.test.ts`, `web/test/sync-engine.test.ts`, coordinator conflict tests, and CI run 29240963980 cover accepted writes, 409 retention, diff3, conflict copies, offline reload, apply-intent recovery, binary blobs, rename/delete, and hidden browser credentials. | None. |
| 9 | **PARTIAL** | Native desktop implementation: `central-vault-sync/src/main.ts`, `local-queue.ts`, `obsidian-adapter.ts`, `plugin-store.ts`; plugin tests/conformance pass. Exact 0.1.4 bytes on real Linux Obsidian 1.12.7 cover Markdown and binary attachments, modify, rename, delete, concurrent uploads, server outage, hard restart, offline cold start, automatic retry, and exact convergence with no conflict/queue residue. | Repeat the copied-vault desktop matrix on real Windows and macOS and retain diagnostics/results. Linux is complete, but unavailable platforms are required by M36.8/stable matrix. |
| 10 | **BLOCKED** | Foreground hooks (`visibilitychange`, `focus`, `active-leaf-change`), durable pending paths/operations/apply intents, bounded mobile large-file confirmation, and mobile-compatible Vault/request APIs are implemented. | Real Android and iOS foreground/suspend/hard-restart tests proving no pending-operation loss. No devices are available. |
| 11 | **PASS** | `clients/headless` implements one-shot modes, watch, status, doctor, conflicts, systemd, and non-root sidecar. Tests include 1 GiB bounded streaming, state/token permissions, daemon lock, unit contract, CLI exit paths; `e2e/headless-pair.mjs` covers two production-build CLI profiles. Real systemd lifecycle and native/emulated amd64/arm64 execution are recorded in the plan. | None for DoD 11. macOS remains a broader M37.8 compatibility gate. |
| 12 | **PASS** | Revocation, hashed tokens, idempotency/replay, rate limits, CSRF, traversal/symlink, blob hash/quota, exact protocol rejection, and WebSocket ticket tests live under `server/test`, core/browser/headless conformance suites, and plugin conformance tests. CI run 29240963980 is green. | None. |
| 13 | **PASS** | Central Sync hard-gates Git pull; coordinator events trigger backup-only commit/push; import preview/confirmed restore creates ordinary revisions. Evidence: `server/test/authority-guard.test.ts`, `import.test.ts`, `backup-restore-drill.test.ts`, migration tests, and `docs/sync/OPERATIONS.md`. | None. |
| 14 | **BLOCKED** | Plugin 0.1.4 is a public prerelease; Dockerfiles are reproducibly built/smoked for amd64/arm64 from source; source-build docs/examples exist. npm artifacts pack/install cleanly. | (1) Create/authorize npm `@webobsidian`, publish core then headless, and verify registry-origin clean install. (2) Submit plugin to Obsidian Community Plugins, resolve review, install/update from the in-app directory. (3) Create stable aligned-version tag and verify GitHub release assets/SBOM/attestations. |

## Phase 31–40 audit

| Phase | Status | Evidence summary |
|---:|:---:|---|
| 31 — contract/architecture | **PASS** | Protocol 1.0 Zod/types, generated JSON Schema/OpenAPI, fixtures, traceability, exact-version negotiation and conformance across all clients. See `packages/sync-core`, `docs/sync/openapi-v1.yaml`, and conformance tests. |
| 32 — metadata/journal/recovery | **PASS** | Checksummed segmented journal, WAL intents, atomic stores, CAS blobs, replay/retention, doctor, corruption/read-only and crash-boundary tests under `server/src/sync` and `server/test`. |
| 33 — mutation authority | **PASS** | `SyncCoordinator`, path/subtree locking, revision/base enforcement, deterministic merge/conflict copies, external reconciliation, derived retries, trash/restore; authority guard and coordinator/fault tests. |
| 34 — API/auth/blob | **PASS** | Pairing/revocation, immutable manifests, ordered changes/acks, resumable uploads, operation batches, health/metrics, HTTPS/CSRF/rate/path defenses, wake-only WebSocket. API/security/E2E tests pass. |
| 35 — browser | **PASS** | httpOnly device cookie, strict durable IndexedDB state, per-document generation-safe saves, offline queue/catch-up, conflict center, attachment transfer, and production two-browser E2E. |
| 36 — native plugin | **PARTIAL** | M36.1–M36.9 implementation/release work and the full real-Linux lifecycle/file-operation matrix are complete; public 0.1.4 exists. | M36.2 npm core publication, M36.7 mobile physical lifecycle, M36.8 Windows/macOS/mobile matrix, and M36.10 Community review remain open. |
| 37 — headless | **PARTIAL** | CLI/daemon, modes, watcher, conflict/doctor/reset, hardened systemd, source-built non-root Docker, two-client E2E, 1 GiB, installed-state upgrade and amd64/arm64 evidence complete. | macOS execution and npm registry publication/install remain open. |
| 38 — Git transition | **PASS** | Backup-only authority, explicit import/restore, legacy hard gate, migration backup prerequisite, LFS separation, bounded retry and drills/tests. |
| 39 — hardening/operations | **PASS** | Existing-vault migration, 10k/50k/reconnect/1 GiB benchmarks, compaction/retention, crash/ENOSPC/corruption/skew/symlink tests, observability, and backup/recovery runbooks/drills. |
| 40 — release/support | **BLOCKED** | M40.1 technical preview is complete. Stable workflow fails closed without npm credential/version alignment, runs both E2Es, publishes npm with provenance, then creates the GitHub release. | Independent private-alpha evidence, public mobile/client matrix, npm scope/publication, Community acceptance, real unavailable platforms, and final stable tag are outstanding. |

## Exact external blockers and required access

1. **npm organization:** create/authorize `@webobsidian` for npm user `picassio`. The current credential can identify
   the user but `npm org ls webobsidian` is forbidden and first core publication returns `E404 Scope not found`.
2. **GitHub Actions npm credential:** configure repository secret `NPM_TOKEN` through a private prompt; never place
   it in chat, logs, source, or documentation.
3. **Obsidian Community submission:** authenticated owner submits
   [`picassio/central-vault-sync`](https://github.com/picassio/central-vault-sync), supplies the review PR URL, and
   permits reviewer-feedback fixes. Acceptance must be verified by in-app Community Plugins install/update.
4. **Physical platforms/testers:** copied non-production vaults on Windows, macOS, Android, and iOS, plus independent
   alpha/beta testers. Record app/OS versions and redacted results using plugin issue
   [#1](https://github.com/picassio/central-vault-sync/issues/1).
5. **Stable publication:** only after all preceding gates pass, align root/core/headless versions, push the
   stable source tag, and verify npm registry packages plus GitHub checksums, SBOM, and attestations. Do not publish
   registry container images.

## Completion rule

Do not mark FR-13 or the active implementation goal complete until every PARTIAL/BLOCKED row above is PASS and its
external URL, artifact digest, test output, screenshot, or review/install evidence has been added here and to
`IMPLEMENTATION_PLAN.md`.

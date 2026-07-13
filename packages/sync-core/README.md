# @webobsidian/sync-core

Shared, platform-neutral Sync Protocol 1.0 contracts and deterministic client state machine for WebObsidian
Central Sync. It includes strict Zod schemas/types, path policy, SHA-256 helpers, replay/conflict primitives,
golden fixtures, and ordered manifest/catch-up/apply-intent/offline-queue orchestration.

```ts
import { OrderedSyncClient, HandshakeResponseSchema, PROTOCOL_VERSION } from '@webobsidian/sync-core';
```

Adapters provide persistence, transport, and local materialization; this package performs no filesystem,
Obsidian, browser, or credential storage itself. A client must durably record an apply intent before local
materialization and advance/acknowledge its cursor only afterward.

- Protocol and OpenAPI: <https://github.com/picassio/webobsidian/tree/main/docs/sync>
- Source: <https://github.com/picassio/webobsidian/tree/main/packages/sync-core>
- Security reports: <https://github.com/picassio/webobsidian/security/advisories/new>

MIT licensed. Protocol 1.0 is pre-stable until the corresponding WebObsidian stable release is published.

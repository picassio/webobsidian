# @picassio/sync-core

Shared, platform-neutral Sync Protocol 1.0 contracts and deterministic client state machine for WebObsidian
Central Sync. It includes strict Zod schemas/types, path policy, SHA-256 helpers, replay/conflict primitives,
golden fixtures, and ordered manifest/catch-up/apply-intent/offline-queue orchestration.

```ts
import { OrderedSyncClient, HandshakeResponseSchema, PROTOCOL_VERSION } from '@picassio/sync-core';
```

Adapters provide persistence, transport, and local materialization; this package performs no filesystem,
Obsidian, browser, or credential storage itself. A client must durably record an apply intent before local
materialization and advance/acknowledge its cursor only afterward. Wake and polling work flush durable local
operations before pulling remote events. Adapters that maintain a separate dirty-path marker can call `enqueue()`,
durably clear that marker, and then call `flush()` so the server echo cannot race the local preparation boundary.
Servers advertising `ordered-batch-stop-v1` allow ordered publication in protocol-sized batches; older servers
remain at one operation/request. Optional lifecycle observers expose safe bootstrap/progress boundaries only after
the corresponding persistence transition.

- Protocol and OpenAPI: <https://github.com/picassio/webobsidian/tree/main/docs/sync>
- Source: <https://github.com/picassio/webobsidian/tree/main/packages/sync-core>
- Security reports: <https://github.com/picassio/webobsidian/security/advisories/new>

MIT licensed. Protocol 1.0 is pre-stable until the corresponding WebObsidian stable release is published.

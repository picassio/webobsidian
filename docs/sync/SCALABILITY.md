# Central Sync Scalability Review and Benchmark Record

Date: 2026-07-13. Protocol/server version: 1.0 / pre-0.1 stable gate.

## Reference host

- Linux 6.8 x86_64, Node 22.22.0
- 32 vCPU Intel Xeon E5-2686 v4 @ 2.30 GHz
- 30 GiB RAM (tests enforce their own 128 MiB deltas)
- Local ephemeral filesystem; no network latency was injected

Commands:

```bash
node --import tsx --test server/test/sync-load.test.ts
node --import tsx --test clients/headless/test/large-file.test.ts
npm test
```

## Recorded results

| Workload | Result | Bound / interpretation |
|---|---:|---|
| Immutable 50,000-entry manifest + 50 × 1,000-entry pages | 7.7 ms | Snapshot remains immutable if source mutates; <128 MiB heap delta. |
| One revision projection update with 50,000 live entries | 1.4 ms | No full JSON rewrite on accepted write; <128 MiB heap delta; well below 2 s clean-update NFR. |
| 500 clients catch up 100 events from warm validated replay cache | 11.7 ms aggregate; 0.023 ms/client | In-process server work, excluding LAN/TLS; comfortably below 500 ms LAN budget. |
| 1,000-event journal creation/rotation + 500-client test fixture | 7.69 s total fixture | Every segment stayed at or below its configured bound. |
| 1 GiB sparse attachment streamed SHA-256 | 12.61 s; +25.5 MiB RSS | Bounded memory; no whole-file buffering. |
| 1 GiB 8 MiB-chunk loopback upload (128 requests) | 3.84 s; +86.9 MiB peak RSS | Real HTTP body transfer stayed below the 128 MiB bound; server-side completion separately verifies hash/size. |
| Coordinator clean create/modify tests | typically <300 ms including fsync/test setup | Below 2 s reference-host gate. |

Numbers are evidence for this host, not universal promises. Production alerting exposes operation average/max latency,
sequence/index/device lag, transfer bytes, and recovery state. Operators should repeat the commands on their storage
class and retain results before a large migration.

## JSON journal/projection architecture review

The JSON-only runtime constraint remains viable; no database engine is introduced.

- **Authority:** append-only, checksummed, fsynced journal segments are the commit point. Segments rotate at 500
  events, so append cost and corruption blast radius are bounded rather than proportional to total history.
- **Projection:** the initial implementation atomically rewrote all 50,000 revision entries after every event
  (~1.2 s on this host), creating unacceptable serialized high-churn behavior. It was replaced before release by
  an O(1) in-memory id/path projection. The projection is rebuildable from the journal and is atomically
  checkpointed by daily maintenance and graceful shutdown, never on the latency-sensitive commit path.
- **Crash behavior:** a stale projection checkpoint is expected and safe. Startup validates the checkpoint cannot
  be ahead, replays contiguous journal events, and then recovers WAL intents. Journal corruption fails closed into
  read-only mode.
- **Bootstrap:** existing-vault hashing has checksummed 5,000-entry checkpoints. Restart reuses stable identities
  and unchanged hashes, rehashes changed paths, and never mutates vault bytes.
- **Replay:** validated journal events are cached; 500 reconnecting clients share replay rather than each parsing
  all segment files.
- **Compaction:** daily maintenance checkpoints the projection even when compaction is acknowledgement-blocked.
  History is removed only when both 30-day age and minimum active-device acknowledgement permit it. Metadata is
  backed up first; unresolved conflict current/submitted/base blobs are protected; merge bases retain up to 20
  versions per entry.
- **Blobs:** content-addressed streaming storage deduplicates by SHA-256. Uploads are chunked at 8 MiB, owned,
  quota-bound, size/hash verified, and expire after 24 hours.

## Capacity gates and stop conditions

Do not promote a deployment if any of these hold on representative hardware/data:

- a clean authoritative update exceeds 2 s under normal load;
- warm LAN catch-up exceeds 500 ms for the expected reconnect set;
- manifest/reconnect/1 GiB hash or HTTP transfer tests exceed 128 MiB incremental memory;
- sequence gaps, non-deterministic replay, unbounded segment growth, or compaction before acknowledgement occurs;
- sustained operation max latency/index lag/device lag alerts cannot be explained and cleared.

If these gates cannot be met after segment/checkpoint/retention tuning, update `PRD.md` and its changelog before
considering a different storage engine. Never silently replace the JSON authority model.

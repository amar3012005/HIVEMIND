# HIVE-MIND Memory Storage Architecture

Status: canonical decision record  
Last reconciled: 2026-08-17  
Authority: `singulance-main`; runtime truth must be verified against the immutable production release.

## Purpose

HIVE-MIND supports three residency modes behind one memory contract. They must produce equivalent authorized recall, evidence, graph, ingestion, and recovery behavior, while differing only in where tenant data is stored and operated.

This document supersedes treating `amr_selfcontained_plan.md`, `byod_amr_parity_plan_2026-08-09.md`, or deployment notes as independent production truth. Those remain implementation history.

## Non-negotiable invariants

1. A successful write means the authoritative row is durable. Vector, entity, graph, and enrichment work may be asynchronous only when each has durable, inspectable recovery state.
2. A transport-level HTTP 2xx is not success when the body reports `ok:false`.
3. Recall is tenant-, user-, scope-, project-, and time-filtered at the authoritative store. Post-filtering is defense in depth, not the primary access boundary.
4. Memory and evidence are searched broadly, merged, deduplicated, and reranked together. Storage mode cannot change answer semantics.
5. No compaction, migration, destructive repair, or cutover runs without a verified backup from the same data shape.
6. Backup existence is not recovery proof. A scheduled restore drill must open the restored store and recall known tenant-scoped facts.
7. Old and new Memory Box agents coexist. Core negotiates capabilities and fails closed for unsupported mutations while retaining compatible reads.
8. Raw tenant content, credentials, and encryption keys never enter logs or backup manifests.

## Authority matrix

| Mode | Intended customer | Authoritative content and graph | Authoritative vector index | Control plane may retain | Required recovery unit |
|---|---|---|---|---|---|
| Personal `.amr` | Free/Plus/Pro/Scale personal workspaces | Per-tenant `.amr` shard files and their local mirrors during migration | Native shard index | Routing, entitlement, non-content operational metadata | Versioned shard snapshot plus manifest |
| Managed enterprise | Singulance-operated enterprise | Central PostgreSQL tenant rows | Managed Qdrant collections | Full governed operational metadata | PostgreSQL PITR/dump plus Qdrant snapshot and release manifest |
| Self-hosted BYOD | Customer-operated enterprise | Customer PostgreSQL in Memory Box | Customer Qdrant in Memory Box | Encrypted endpoint/token metadata and minimal health/capability state | Customer-controlled PostgreSQL dump plus Qdrant snapshot and agent configuration manifest |

The current standalone BYOD agent is PostgreSQL + Qdrant. It is not represented as `.amr` until a measured dual-write/read-compare/cutover proves parity. A future native shard is an implementation change, not an architectural assumption.

## Common lifecycle

```text
authenticated request
  -> resolve tenant residency and authorized scope
  -> authoritative write commits
  -> durable work ledger records vector/entity/graph/enrichment state
  -> asynchronous workers retry idempotently
  -> health reports complete, pending, partial, stale, or failed
  -> recall queries memory + evidence lanes in the selected store
  -> one unified rerank and evidence delivery contract
  -> citations retain source and project identity
```

## Personal `.amr`

### Current shape

The native shard contains record, vector, text, and edge files. Embedded-agent routes provide the stable memory/evidence API. SQL/Qdrant mirrors can exist while lane parity is being measured; they must not silently become a second authority.

### Required safety controls

- Snapshot to a staging directory, hash every artifact, write the manifest last, verify it, then atomically publish the snapshot.
- Compact only shards successfully snapshotted in the same maintenance pass.
- Copy completed snapshots off-host; local retention alone does not survive device loss.
- Expose doctor output: format version, artifact hashes, last verified backup, compaction debt, index readiness, and recoverable work counts.
- Import/restore into an isolated directory first; validate and recall a canary before atomically switching the active shard.
- Multi-device use requires one writer lease or an explicit conflict protocol. File synchronization tools are not a concurrency protocol.

### Portable encrypted recovery procedure

`core/scripts/amr-portable.mjs` is the operator interface for moving a personal
shard between hosts. It never exports a live shard directly: `export` first
verifies a completed snapshot, packages only its declared artifacts, then
encrypts the package with authenticated AES-256-GCM. The passphrase is supplied
only through `AMR_EXPORT_PASSPHRASE` and must not be written to a command line,
log, manifest, or receipt.

```text
AMR_EXPORT_PASSPHRASE=... node core/scripts/amr-portable.mjs export \
  --snapshot <verified-snapshot-directory> --out <bundle.hmamr>

AMR_EXPORT_PASSPHRASE=... node core/scripts/amr-portable.mjs import \
  --bundle <bundle.hmamr> --destination <empty-isolated-directory>

node core/scripts/amr-portable.mjs activate \
  --imported <verified-import-directory> --live <offline-live-shard-directory>
```

Import authenticates the bundle before extraction, rejects unsafe or unexpected
archive entries, verifies every snapshot hash, opens the restored shard in
isolation, and writes a receipt bound to both bundle and manifest hashes.
Activation is deliberately separate. The shard service must be offline;
activation refuses an active writer lock, requires a same-filesystem atomic
rename, retains the previous live directory as rollback, and restores it if the
cutover fails. A verified local bundle is not an off-host backup: operators must
still copy it to independently durable storage and verify it there before
enabling compaction or destructive maintenance.

For scheduled operation, set `MNEME_OFFSITE_UPLOAD_ENABLED=true`, provide
`AMR_EXPORT_PASSPHRASE` from the secret manager, and configure
`AMR_OFFSITE_UPLOAD_COMMAND`. The command receives `BACKUP_PATH` (the encrypted
bundle), `BUNDLE_SHA256`, and `SNAPSHOT_MANIFEST_SHA256`; it must return zero
only after the remote object is durable and checksum-verified. The maintenance
worker writes and revalidates `OFFSITE_RECEIPT.json` afterward. Even when
`MNEME_COMPACT_ENABLED=true`, only shards with a receipt bound to the exact
same-pass snapshot are eligible for compaction. Missing upload configuration,
upload failure, or a mismatched receipt therefore skips compaction safely.

## Managed enterprise

### Current shape

PostgreSQL owns content, metadata, provenance, graph, lifecycle state, and authorization. Qdrant is the rebuildable semantic index only when every vector has a durable synchronization ledger and repair path.

### Required safety controls

- PostgreSQL point-in-time recovery or equivalent continuous log archive, plus portable dumps.
- Qdrant snapshots coupled to a manifest that records collection, dimension, embedding model/version, and PostgreSQL recovery boundary.
- Encryption in transit and at rest, with tested key rotation and recovery access separated from application credentials.
- Managed backup artifacts are packaged only after manifest verification and encrypted as an authenticated `.hmstorage` bundle. The backup key lives in a root-only operator file outside the Compose environment; upload commands receive ciphertext and its checksum, never the key or plaintext directory.
- Per-tenant failure isolation for queues, circuits, quotas, and maintenance so one tenant cannot starve interactive recall for another.
- Restore drills into a non-production namespace; validate counts, tenant isolation, vector dimension, graph links, evidence hydration, and exact recall canaries.
- A weekly locked systemd drill decrypts the newest managed bundle with the operator-only key, restores PostgreSQL/Qdrant/AMR into disposable namespaces, and atomically records a content-free verification receipt retained for 90 days.

## Self-hosted BYOD Memory Box

### Current shape

The customer box owns PostgreSQL and Qdrant. Core sends authenticated requests through a versioned HTTP contract. Core must never infer agent support from deployment age.

### Required safety controls

- `/v1/capabilities` advertises protocol/schema version, vector dimension, and individual operations.
- Every mutation validates the response body; `ok:false` remains retryable/failed even with HTTP 200.
- Durable `vector_synced` state and specialized id-plus-vector repair avoid replaying or overwriting canonical content.
- A customer-run backup command creates PostgreSQL and Qdrant artifacts, hashes them, and emits a portable manifest without secrets.
- A doctor command validates dependencies, schema, dimension, disk headroom, backup freshness, pending recovery work, and Core reachability.
- Offline writes queue durably and replay idempotently. Interactive reads fail honestly when the authoritative box is unavailable.
- The offline delivery queue stores only authenticated encrypted envelopes. Sequence allocation is serialized per record, pending/dead envelopes support key rotation, and acknowledged rows redact their payload immediately. Historical plaintext rows must be migrated before `PUSH_OUTBOX_REQUIRE_ENCRYPTION=true` is enabled.
- Agent upgrades are immutable, signed, rollbackable, and backward compatible for at least the supported protocol window.
- Core retains only endpoint, encrypted credentials, negotiated capabilities, last-seen health, and non-content counters.

## Capability contract

Capabilities are granular strings, not a single version boolean. At minimum:

- `memory.recall`, `memory.lexical`, `memory.hydrate`
- `evidence.recall`, `evidence.lexical`, `evidence.hydrate`
- `vector.status`, `vector.pending`, `vector.repair`
- `backup.create`, `backup.verify`, `restore.verify`
- `graph.read`, `entity.read`, `provenance.read`

Core caches negotiation briefly, invalidates on agent identity/version change, treats 404 as legacy mode, and never sends unsupported recovery mutations.

## Backup manifest contract

Every recovery unit has a JSON manifest written last and containing:

- manifest version, storage mode, tenant pseudonymous identifier, created-at;
- release/protocol/schema versions;
- artifact relative names, exact byte lengths, SHA-256 hashes;
- vector dimension and model/index version where relevant;
- consistency boundary and whether the snapshot is warm or stopped;
- `complete:true` only after local verification.

Secrets, raw content, tokens, database URLs, and absolute host paths are forbidden.

## Cutover rules

No storage migration is a flag flip. Each lane follows:

```text
dormant capability -> dual-write -> durable repair -> read-compare
-> tenant canary -> percentage rollout -> authoritative cutover
-> rollback window -> old-store retirement
```

The gate is measured tenant-safe parity on real embeddings and real evidence, not unit tests alone.

## Production release rule

Storage changes are released from a clean worktree at a merged `singulance-main` SHA. Build and deploy only affected services with immutable tags. Before and after deployment record the active image, database migration, backup manifest, canary tenant, restore result, and rollback target.

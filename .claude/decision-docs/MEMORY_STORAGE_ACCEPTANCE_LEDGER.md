# Memory Storage Acceptance Ledger

Status values: `NOT_PROVEN`, `PASS`, `FAIL`, `BLOCKED`. A code merge or healthy container is never `PASS` by itself.

## Release identity

| Field | Evidence |
|---|---|
| Canonical merged SHA | `PASS` — storage runtime included in `7b4034368fc981fcac11e3c8b5f0b31d269fb3a4`; isolated restore automation through `d7688e0738c049f9e4816a268954373b880ea4a9`; AMR doctor through `dc01be0d1f5ccc00ef38595370dee24018e2da21` |
| Immutable images | `PASS` — Core `sha-6681586d`; Memory Box agent `sha-7b403436` |
| Migration IDs | `NOT_PROVEN` |
| Rollback targets | `PASS` — Core canonical release rollback manifest; Memory Box agent `sha-7a8298a8` retained as rollback image |

## Personal `.amr`

| Gate | Status | Required evidence |
|---|---|---|
| Atomic snapshot publication | `PASS` — v2 staging + verify + rename; 7/7 live shards published on 2026-08-17 | Killed copy leaves no complete restore point |
| Artifact integrity | `PASS` — 7/7 production v2 snapshots verified; corruption regression test passes | Byte/hash verification detects mutation |
| Off-host copy | `NOT_PROVEN` | Object exists outside the device and verifies |
| Restore open | `PASS` — production doctor cryptographically verified and opened isolated copies of all 7/7 shards; six non-empty shards contained 447 live records and one valid new/empty slot was identified | Restored shard opens without repair |
| Restore recall | `NOT_PROVEN` | Known memory and evidence return with exact scope |
| Compaction safety | `NOT_PROVEN` | Only same-pass verified shards compact; recall parity retained |
| Crash during write | `PASS` — native commit-last recovery test discards an uncommitted 37-record tail while retaining and recalling all 100 acknowledged records; phantom-slot and reopen suites pass | Last acknowledged write survives or is durably retryable |
| Multi-device writer safety | `PASS` for a shared filesystem — native non-blocking exclusive `flock` rejects a second writer; cross-device/cloud-file synchronization remains explicitly unsupported | Conflicting writers cannot silently corrupt the shard |

## Managed enterprise

| Gate | Status | Required evidence |
|---|---|---|
| PostgreSQL recovery point | `PASS` for portable dump restore; PITR remains `NOT_PROVEN` — isolated restore contained 813 tables | Timestamp/LSN and successful isolated restore |
| Qdrant recovery | `PASS` — exact v1.12.4 full snapshot restored 21 collections; canary collection contained 2 points | Snapshot restores expected collections/dimension/counts |
| Cross-store consistency | `PASS` — 2026-08-17 full production comparison checked 1,304 active memories: 1,304/1,304 actual Qdrant points recorded `synced`, zero missing/failed; all 5,540 evidence rows report `vector_stored=true` | Pending vectors repaired; no false `synced` rows |
| Tenant isolation | `PASS` — immutable Core `sha-6681586d`; storage-boundary canary returned 20/20 correctly scoped org hits and 20/20 correctly scoped project hits, while an Org A context attempting an Org B filter was rejected before Qdrant | Cross-tenant/project negative tests for memory and evidence |
| Graph/provenance recovery | `PASS` — isolated managed restore on 2026-08-17 recovered 2,134 relationships, 1,286 memory-evidence links, 3,204 memory-entity links, and 1,834 canonical entities | Links and citations survive restore |
| Encryption/key recovery | `NOT_PROVEN` | Restore operator can decrypt; application credentials cannot manage keys |
| Failure isolation | `NOT_PROVEN` | One tenant outage does not exhaust another tenant's interactive budget |

## Self-hosted BYOD

| Gate | Status | Required evidence |
|---|---|---|
| Capability negotiation | `PASS` — live agent reports `memory-box.v1`, release `7b403436`, storage `byod_postgres_qdrant`, dimension 1024 | New and legacy agents select compatible operations |
| Acknowledgement semantics | `PASS` — regression test rejects HTTP 200 with `ok:false`; live vector backlog is zero | HTTP 200 plus `ok:false` is failed/retryable, never success |
| Backup create/verify | `PASS` — customer bundle `88f0e8ec`; production PG/Qdrant manifest verifies with exact image IDs | Customer-owned PG/Qdrant artifacts and manifest verify |
| Box-loss restore | `PASS` — isolated restore recovered 47 memories, 3 evidence segments, one Qdrant collection and 25 points | Fresh box restores and recalls scoped memory plus evidence |
| Vector repair | `PASS` for forced failure/idempotent repair tests; full post-restore recall canary remains part of cross-mode gate | Forced Qdrant failure remains pending, repairs idempotently |
| Offline/reconnect | `NOT_PROVEN` | Durable pending work resumes without content overwrite |
| Upgrade/rollback | `NOT_PROVEN` | Signed immutable agent upgrade and previous-image rollback |
| Residency | `NOT_PROVEN` | Raw content absent from central persistence and logs |

## Cross-mode parity

Run the same corpus and identities in all modes. Required cases:

- exact fact, broad summary, temporal query, entity/product query, graph relation;
- evidence-only, memory-only, and mixed memory/evidence;
- personal, organization, team, project, and denied project;
- update/supersession, deletion, ingestion retry, duplicate delivery;
- English and at least two non-English corpora;
- backup corruption, process kill, dependency timeout, and network partition.

For every case record: full request identity (without secrets), ranked IDs, citations, storage mode, retrieval/rerank latency, authoritative counts, and fresh logs.

## Completion rule

The program is complete only when every applicable row is `PASS` with a dated artifact or command result. Unsupported gates must be explicitly documented and accepted; they are not silently removed.

# Memory Storage Acceptance Ledger

Status values: `NOT_PROVEN`, `PASS`, `FAIL`, `BLOCKED`. A code merge or healthy container is never `PASS` by itself.

## Release identity

| Field | Evidence |
|---|---|
| Canonical merged SHA | `NOT_PROVEN` |
| Immutable images | `NOT_PROVEN` |
| Migration IDs | `NOT_PROVEN` |
| Rollback targets | `NOT_PROVEN` |

## Personal `.amr`

| Gate | Status | Required evidence |
|---|---|---|
| Atomic snapshot publication | `NOT_PROVEN` | Killed copy leaves no complete restore point |
| Artifact integrity | `NOT_PROVEN` | Byte/hash verification detects mutation |
| Off-host copy | `NOT_PROVEN` | Object exists outside the device and verifies |
| Restore open | `NOT_PROVEN` | Restored shard opens without repair |
| Restore recall | `NOT_PROVEN` | Known memory and evidence return with exact scope |
| Compaction safety | `NOT_PROVEN` | Only same-pass verified shards compact; recall parity retained |
| Crash during write | `NOT_PROVEN` | Last acknowledged write survives or is durably retryable |
| Multi-device writer safety | `NOT_PROVEN` | Conflicting writers cannot silently corrupt the shard |

## Managed enterprise

| Gate | Status | Required evidence |
|---|---|---|
| PostgreSQL recovery point | `NOT_PROVEN` | Timestamp/LSN and successful isolated restore |
| Qdrant recovery | `NOT_PROVEN` | Snapshot restores expected collections/dimension/counts |
| Cross-store consistency | `NOT_PROVEN` | Pending vectors repaired; no false `synced` rows |
| Tenant isolation | `NOT_PROVEN` | Cross-tenant/project negative tests for memory and evidence |
| Graph/provenance recovery | `NOT_PROVEN` | Links and citations survive restore |
| Encryption/key recovery | `NOT_PROVEN` | Restore operator can decrypt; application credentials cannot manage keys |
| Failure isolation | `NOT_PROVEN` | One tenant outage does not exhaust another tenant's interactive budget |

## Self-hosted BYOD

| Gate | Status | Required evidence |
|---|---|---|
| Capability negotiation | `NOT_PROVEN` | New and legacy agents select compatible operations |
| Acknowledgement semantics | `NOT_PROVEN` | HTTP 200 plus `ok:false` is failed/retryable, never success |
| Backup create/verify | `NOT_PROVEN` | Customer-owned PG/Qdrant artifacts and manifest verify |
| Box-loss restore | `NOT_PROVEN` | Fresh box restores and recalls scoped memory plus evidence |
| Vector repair | `NOT_PROVEN` | Forced Qdrant failure remains pending, repairs idempotently |
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


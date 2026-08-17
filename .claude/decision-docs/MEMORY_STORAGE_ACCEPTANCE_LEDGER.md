# Memory Storage Acceptance Ledger

Status values: `NOT_PROVEN`, `PASS`, `FAIL`, `BLOCKED`. A code merge or healthy container is never `PASS` by itself.

## Release identity

| Field | Evidence |
|---|---|
| Canonical merged SHA | `PASS` — storage runtime included in `7b4034368fc981fcac11e3c8b5f0b31d269fb3a4`; isolated restore automation through `d7688e0738c049f9e4816a268954373b880ea4a9`; portable/off-host AMR recovery through `562c4da8bc86941289985c699c7e17218de284c3`; encrypted BYOD replay through `dc51d2a3e48626238605126df7028c4192d70d9c`; managed tenant admission through `b3c2382e24997e17b5f38a676c4fe969fdbe18bc`; managed PITR through `71363e50d58b9927e49542b40dd616b0e63f4bc6`; signed BYOD upgrade/rollback drill through `e55880cc4ebacbe369e4a04690984046dba47899`; Unicode `.amr` lexical through `5975a2791784e29e32e03762c2c2e68b91681c96`; managed Unicode lexical through `04a434059843e5e654282f8700668c8b09375c65` |
| Immutable images | `PASS` — Core `sha-3fb78531`; PostgreSQL `sha-71363e50`; Memory Box agent `sha-7b403436` |
| Migration IDs | `FAIL` — production has 160 repository migrations but no `hivemind._prisma_migrations` ledger because the former 40-row Prisma ledger moved with the archived `public` schema. `prisma migrate status` therefore reports all 160 as unapplied, and schema diff also shows material drift. Do not run `prisma migrate deploy` until a reviewed baseline/reconciliation is completed. `core/scripts/prisma-migrate-deploy.mjs` now fails closed when an existing application schema lacks its current ledger; this prevents accidental historical DDL replay but does not make the ledger correct |
| Rollback targets | `PASS` — Core canonical release rollback manifest; Memory Box agent `sha-7a8298a8` retained as rollback image |

## Personal `.amr`

| Gate | Status | Required evidence |
|---|---|---|
| Atomic snapshot publication | `PASS` — v2 staging + verify + rename; 7/7 live shards published on 2026-08-17 | Killed copy leaves no complete restore point |
| Artifact integrity | `PASS` — 7/7 production v2 snapshots verified; corruption regression test passes | Byte/hash verification detects mutation |
| Off-host copy | `PASS` — authenticated AES-256-GCM bundle `managed-amr-20260817T121043Z.hmstorage` copied from production to the independent macOS host at `/Users/amar/HIVEMIND_RECOVERY_OFFHOST/2026-08-17`, 341,964,940 bytes, source/destination SHA-256 `c7d2b68b…abfa`, mode `0600`. The recovery key is escrowed in the macOS login Keychain (not beside the bundle); an ephemeral local container authenticated/decrypted it and reverified all 3 manifest artifacts without retaining plaintext | Object exists outside the device and verifies |
| Restore open | `PASS` — production doctor cryptographically verified and opened isolated copies of all 7/7 shards; six non-empty shards contained 447 live records and one valid new/empty slot was identified | Restored shard opens without repair |
| Portable encrypted recovery | `PASS` — Linux candidate `3e53c9d3` authenticated an AES-256-GCM export/import, rejected wrong keys and unsafe/truncated bundles, opened the isolated shard, and proved atomic activation rollback | Bundle and receipt bind the verified snapshot; activation refuses a live writer |
| Restore recall | `PASS` — Linux native-engine test exported a real dimension-8 shard, imported it in isolation, and recalled the exact known record/vector; production snapshot probe remains required after canonical deployment | Known memory and evidence return with exact scope |
| Compaction safety | `PASS` for the fail-closed gate and native recall parity; live-shard compaction remains deliberately disabled until the independent off-host gate passes — Linux native acceptance at canonical SHA `6b3af414` created 40 records, tombstoned 20, generated rewrite garbage, proved no compaction eligibility without the exact same-pass receipt, then compacted only after binding that receipt. Live count stayed 20 and the full ranked recall ID sequence was byte-for-byte identical before and after compaction | Only same-pass verified shards compact; recall parity retained |
| Crash during write | `PASS` — native commit-last recovery test discards an uncommitted 37-record tail while retaining and recalling all 100 acknowledged records; phantom-slot and reopen suites pass | Last acknowledged write survives or is durably retryable |
| Multi-device writer safety | `PASS` for a shared filesystem — native non-blocking exclusive `flock` rejects a second writer; cross-device/cloud-file synchronization remains explicitly unsupported | Conflicting writers cannot silently corrupt the shard |

## Managed enterprise

| Gate | Status | Required evidence |
|---|---|---|
| PostgreSQL recovery point | `PASS` — production pgBackRest archived WAL `00000001000000010000000D`, completed encrypted full backup `20260817-121416F` (414,914,469 logical bytes), and restored to a named point in a disposable volume with baseline row 1 and post-target row 0. Receipt: `/var/lib/hivemind/pitr-drills/20260817T121414Z.json`. A copied repository was independently accepted by `pgbackrest info` (1 full backup plus archived WAL), packaged as authenticated AES-256-GCM bundle `managed-pitr-20260817T131500Z.hmstorage`, copied off-host to macOS with matching 193,833,100-byte SHA-256 `63f5a522…5438`, then authenticated/decrypted and manifest-verified in an ephemeral local container. Weekly-full and daily-differential timers are active | Timestamp/LSN and successful isolated restore |
| Qdrant recovery | `PASS` — exact v1.12.4 full snapshot restored 21 collections; canary collection contained 2 points | Snapshot restores expected collections/dimension/counts |
| Cross-store consistency | `PASS` — 2026-08-17 full production comparison checked 1,304 active memories: 1,304/1,304 actual Qdrant points recorded `synced`, zero missing/failed; all 5,540 evidence rows report `vector_stored=true` | Pending vectors repaired; no false `synced` rows |
| Tenant isolation | `PASS` — immutable Core `sha-6681586d`; storage-boundary canary returned 20/20 correctly scoped org hits and 20/20 correctly scoped project hits, while an Org A context attempting an Org B filter was rejected before Qdrant | Cross-tenant/project negative tests for memory and evidence |
| Graph/provenance recovery | `PASS` — isolated managed restore on 2026-08-17 recovered 2,134 relationships, 1,286 memory-evidence links, 3,204 memory-entity links, and 1,834 canonical entities | Links and citations survive restore |
| Encryption/key recovery | `PASS` — 2026-08-17 operator drill encrypted the real 331,724,940-byte managed recovery unit, authenticated and decrypted it into isolation, reverified all 3 manifest artifacts, and removed the probe; the 32-byte key is root-only outside Compose and absent from Core | Restore operator can decrypt; application credentials cannot manage keys |
| Failure isolation | `PASS` — immutable Core `sha-b3c2382e` gates `/api/chat`, `/api/recall`, and graph work by organization with independent bounded FIFOs, disconnect cleanup, and no false release of still-running work. Unit acceptance saturated tenant A while tenant B acquired immediately; the production route canary launched eight tenant-A recalls and tenant B still returned grounded memory/evidence in 1,267 ms while tenant-A requests completed in 1,795–3,338 ms. Core remained healthy with zero restarts and no fresh gate, bulkhead, circuit, timeout, or application errors | One tenant outage does not exhaust another tenant's interactive budget |

## Self-hosted BYOD

| Gate | Status | Required evidence |
|---|---|---|
| Capability negotiation | `PASS` — live agent reports `memory-box.v1`, release `7b403436`, storage `byod_postgres_qdrant`, dimension 1024 | New and legacy agents select compatible operations |
| Acknowledgement semantics | `PASS` — regression test rejects HTTP 200 with `ok:false`; live vector backlog is zero | HTTP 200 plus `ok:false` is failed/retryable, never success |
| Backup create/verify | `PASS` — customer bundle `88f0e8ec`; production PG/Qdrant manifest verifies with exact image IDs. The verified bundle was wrapped as AES-256-GCM `byod-20260817T101323Z.hmstorage`, copied to the independent macOS host at 768,140 bytes with matching source/destination SHA-256 `38e8cb82…47a7`, authenticated/decrypted off-host, and both manifest artifacts reverified in an ephemeral container | Customer-owned PG/Qdrant artifacts and manifest verify |
| Box-loss restore | `PASS` — isolated restore recovered 47 memories, 3 evidence segments, one Qdrant collection and 25 points | Fresh box restores and recalls scoped memory plus evidence |
| Vector repair | `PASS` for forced failure/idempotent repair tests; full post-restore recall canary remains part of cross-mode gate | Forced Qdrant failure remains pending, repairs idempotently |
| Offline/reconnect | `PASS` — 2026-08-17 production drill persisted an authenticated encrypted write during forced `ECONNREFUSED`, survived a Core recreation, delivered the exact record/vector after reconnect, transitioned to `acked`, and redacted the payload | Durable pending work resumes without content overwrite |
| Upgrade/rollback | `PASS` for cryptographic signing and restored-data upgrade/rollback; independent customer-accessible registry publication remains `BLOCKED` — root-only Ed25519 key signed `agent-e55880cc`; disposable PostgreSQL/Qdrant restore upgraded from image ID `150d4da6…` to the signed digest/image ID `df0c0b2a…`, then rolled back to `150d4da6…`. Memory recall stayed 5 and evidence recall stayed 3 at base, upgraded, and rolled-back stages. Receipt: `/var/lib/hivemind/byod-release-drills/20260817T122700Z.json`. Canonical workflow `publish-memory-box-agent` now owns `packages:write`, immutable GHCR publishing, public visibility, and digest output, but GitHub run `32035062475` was rejected before its first step because the account is billing-locked. A local GH token also lacks `write:packages` and was removed from the server immediately after GHCR rejected it | Signed immutable agent upgrade and previous-image rollback |
| Residency | `PASS` for Core storage/log boundary — active self-host registry contained one org with 0 central memories, 0 central documents, and 0 central segments; 19,138 acknowledged outbox rows were redacted, 116 dead rows were encrypted, 0 payloads remained plaintext/unclassified, and the reconnect canary had 0 Core log matches | Raw content absent from central persistence and logs |

## Cross-mode parity

Run the same corpus and identities in all modes. Required cases:

- exact fact, broad summary, temporal query, entity/product query, graph relation;
- evidence-only, memory-only, and mixed memory/evidence;
- personal, organization, team, project, and denied project;
- update/supersession, deletion, ingestion retry, duplicate delivery;
- English and at least two non-English corpora;
- backup corruption, process kill, dependency timeout, and network partition.

For every case record: full request identity (without secrets), ranked IDs, citations, storage mode, retrieval/rerank latency, authoritative counts, and fresh logs.

### Proven cross-mode cases (2026-08-17)

| Case | Personal `.amr` | Managed enterprise | Self-hosted BYOD |
|---|---|---|---|
| Unicode lexical recall | `PASS` — native Linux shard recalled Arabic contract identifier `٩٨٧٦` and Spanish retention text after restart at Core `5975a279` | `PASS` — production-container source-first lifecycle at Core `04a43405` persisted and recalled a distinct Spanish nine-month review fact and Arabic contract identifier `٩٨٧٦`; isolated tenant returned zero results; test cleaned up its temporary tenants | `PASS` — disposable agent PostgreSQL/Qdrant fixture recalled Spanish memory content and Arabic evidence content, then repeated the same authenticated, tenant-isolated result after agent restart at canonical `6aa4029b` |
| Compaction / restart preservation | `PASS` — 40 writes, 20 tombstones, exact ranked-ID parity after receipt-gated compaction | `NOT_PROVEN` as a cross-mode corpus case; PostgreSQL PITR and Qdrant snapshot rows above are independently proven | `PASS` — fixture write/read parity survived agent restart; signed restored-data upgrade/rollback preserved 5 memory and 3 evidence hits at every stage |
| Scope isolation in the parity fixture | Native org/shard isolation suites `PASS`; full personal/team/project matrix remains `NOT_PROVEN` here | `PASS` for the temporary cross-org negative assertion; team/project/denied-project parity remains `NOT_PROVEN` here | `PASS` for wrong-token and wrong-org rejection; team/project/denied-project parity remains `NOT_PROVEN` here |
| Evidence-only public lifecycle | `NOT_PROVEN` in the shared cross-mode corpus | `NOT_PROVEN` in the shared cross-mode corpus | `PASS` — on 2026-08-17 immutable Core `sha-3fb78531` accepted a real organization-scoped evidence-only Markdown upload, the Memory Box stored one segment, direct remote lexical and hydration returned 4 rows, public `/api/recall` returned 2 grounded evidence rows, central document/segment/memory counts remained `0/0/0`, deletion succeeded, and the deleted marker no longer recalled. The temporary API key and document were removed; durable reusable canary: `core/scripts/byod-evidence-lifecycle-canary.mjs` |

The entire cross-mode gate remains `NOT_PROVEN`: broad summaries, temporal queries, full evidence-only/memory-only/mixed ranking, team/project/denied-project parity, update/deletion/retry/duplicate delivery, and the complete failure-injection matrix still require one shared corpus with ranked-ID, citation, latency, count, and fresh-log receipts.

## Completion rule

The program is complete only when every applicable row is `PASS` with a dated artifact or command result. Unsupported gates must be explicitly documented and accepted; they are not silently removed.

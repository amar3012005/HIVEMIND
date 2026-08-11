# mneme / `.amr` — single-file memory engine + per-org storage driver

**Date:** 2026-06-24 → 2026-06-26
**Status:** shipped, live on sai (org `71bc75ab` "SOLVIS"), flag-gated, reversible
**Branch:** `feat/mneme-foundation`

## What shipped
A tenant's entire memory layer can now be served from a **single `.amr` file** instead of
Postgres + Qdrant — selected by **one config value**, with the **pipeline unchanged**. Live for one
org; every other org runs the existing hybrid stack untouched.

```
MNEME_ORGS = ""(none) | "<orgId>"(one) | "a,b"(several) | "*"(all)
```

## Why
- **Data sovereignty / self-host**: one file is trivially portable; a customer can host their own
  memory without running Postgres+Qdrant.
- **Cost + ops**: no per-tenant DB/vector infra; embedded, in-process, zero servers.
- **Product**: the moat — agent memory (semantic + entity + bi-temporal + typed graph) co-located
  in one byte layout, served from one mmap read.

## The engine (`.amr` format)
- Fixed-stride **202-byte slot**: id, flags+layer, created_at, valid_from, PQ vector[128],
  entity_bitmap[8], adjacency[32]. Companion files: `.vec .txt .mnsw .edg .lock` + JSON sidecars.
- **Crash-safe** (`committed_count` checkpoint, recover-on-open), **persistent HNSW** (`.mnsw`,
  no rebuild on restart), **single-writer flock**, **async indexer** (bounded queue, lag/failure
  metrics, no silent drops).
- **Scale-proven**: 1M real SIFT recall@10 = 0.9996 @ p50 1.5ms; 10M flat 2.15ms after a
  rerank-depth cap. int8 quantization, on-disk vectors.
- **3 layers** (evidence / memory / cognitive) tagged in 2 flag bits, filtered per usage.
- Native Node binding (`singulance-amr.*.node`); methods incl. `insertLayered`, `recallLayer`,
  `allRecords`, `slotEdges`, `delete`, `addEdge`, `traverseTyped`, `asOf`.

## Path B — `.amr` as a relational store (the hard part)
HIVEMIND `memory` is a relational hub (a dozen FK-children). To take a tenant fully off Postgres we
built a **Prisma-compatible layer over `.amr`**:
- **Query engine** — WHERE (AND/OR/NOT, in/gt/contains/has/hasSome, null, relation filters),
  orderBy, take/skip, select, count, findUnique/findFirst, groupBy, aggregate.
- **Adapter** — `memory`/`relationship`/`knowledgeSegment` + the FK-children as models; full Prisma
  method surface; compound/unique-key resolution.
- **`.amr` backend** — records ↔ slots (full-record JSON + vector + layer), relationships ↔ typed
  edges, the rest → per-model JSON sidecars (`SidecarBackend`). No FK enforcement off-Postgres = the
  hub leaves PG cleanly.

## The cutover bugs (each a commit)
The journey from "shadow mirror" to "true PG=0" surfaced and fixed:
1. **Split-brain** — post-capture proxy injection missed early-captured clients → **stable singleton
   proxy** (`getPrismaClient` returns ONE proxy, routes per-call). `e74dc58e`
2. **Transactions bypassed routing** — `this.client.$transaction(tx => new PrismaGraphStore(tx))`
   used the raw tx client → **proxy wraps `$transaction`**, the tx client routes too. `f2219b98`
3. **FK hub** — routing only `memory` broke `source_metadata_memory_id_fkey` → **route the whole
   12-table subgraph** (sourceMetadata, memoryVersion, memoryProject, codeMemoryMetadata,
   derivationJob, memoryDerivation, memoryEvidenceLink, vectorEmbedding, entityMention,
   memoryEntityLink, knowledgeDocument, knowledgeSegment). `bac0fa4f` `79381c04`
4. **FK-child routing** — children query by `memoryId`/`segmentId`/`fromId`, not `orgId` → route by
   **reference-in-adapter** (`refsAmrRecord`) + own-id. `689270d5` `9befad18` `6d47ac55`
5. **Qdrant point-id** — adapter `genId` produced `amr_*` → **UUIDs**. `9befad18`
6. **Recall parity** — the `.amr` recall now applies **the hybrid pipeline's OWN filter**
   (project-scope, entity, cross-layer, multi-scope, is_latest, promoted-exclusion) to `.amr`
   candidates — recall logic unchanged, only the store swapped. `30f49829`

## The driver pattern (the "one flip", future-proof)
All backend-aware logic consolidated into **`core/src/vector/mneme/driver.js`** — the single seam.
`db/prisma.js` + `qdrant-client.js` call only the driver (`wrapPrisma` / `amrRecall` / `amrWrite` /
`isMnemeOrg` / `configureDriver`). `10bbb65c`
- **Multi-org**: each `.amr` org → its own store; FK-children route to whichever adapter holds the ref.
- **Fail-loud**: an unsupported query shape **throws** (never silent-wrong).
- **Conformance harness**: asserts the `.amr` adapter ≡ Prisma semantics on the real query shapes —
  a CI gate that catches mismatches when **any** feature upgrades.
- **Back-compat**: `MNEME_PRISMA_ORG` still honored.

## Flags / config
- `MNEME_ORGS` (csv | `*`) — which orgs use `.amr`. Unset = hybrid for everyone (zero overhead).
- `MNEME_DATA_ROOT` (default `/app/data/mneme`), `MNEME_BINDING`, `EMBEDDING_DIMENSION=1024`.

## Verification
- **79 unit cases green** (query-engine 12, adapter 9, conformance 16, proxy 8, realfix 8, tx 3,
  recall-filter 9, subgraph 8, driver-live 6).
- **Live on sai** (`71bc75ab`): full SOLVIS corpus ingested, **0 FK/embed/promote errors**, **PG=0**,
  recall served from `.amr` with real facts.

## Risks / open items
- **`.amr` is the sole copy** for an `.amr` org (PG wiped) → flag-off is NOT a safe rollback; needs a
  backup cron. Backups: `/opt/HIVEMIND/backups/{sai-amr,amr-code}-*.tgz`.
- **Single replica only** — `.amr` is single-writer (flock); pin the writer before scaling hm-core.
- **Box hot-patched** (`db/prisma.js`, `qdrant-client.js`, `server.js` diverged) — land in a PR or a
  redeploy from `main` reverts the cutover.
- **Org-id discipline**: resolve a tenant's org by email lookup, never a memorized id (a wrong-org
  mistake cost real time — `723f0f5b` was orphaned; sai is `71bc75ab`).

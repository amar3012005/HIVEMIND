# 05 — Evidence / Vector Layer (Qdrant + embeddings)

Migration to bge-m3 1024-dim + per-org Qdrant containers. Landed **Jun 3–4**.

## Commits

| SHA | Summary |
|-----|---------|
| `760731e` | bge-m3 primary/fallback embed factory (step 2 wiring) |
| `12dcb34` | auto-provision per-org Qdrant container on org creation |
| `39224d7` | per-tenant collection routing + layer filters (P3) + fix evidence threshold |
| `0bff6ff` | plan-based routing (personal pool vs enterprise container) + per-tenant delete cascade |
| `39001de` | resolveCollectionForOrg selects plan only (vector_container column lags prisma on prod) |
| `7d700d5` | bound embed fetch with timeout (no more indefinite hang) |
| `c55c385` / `a8d91ce` | migration docs: bge-m3 cutover + org-container plan |

## What was built

### bge-m3 embed factory
- Composite embed service: primary by `EMBEDDING_PROVIDER`, optionally wrapped
  with `EMBEDDING_FALLBACK_PROVIDER` so a primary outage (prometheus GPU box
  behind ephemeral tunnel) transparently degrades to blaiq LiteLLM.
- Both run bge-m3 → **1024-dim** vectors, interchangeable.
- Dark-safe: with no fallback set, returns the bare primary (= pre-change behavior).
- `getEmbedService()` + `FallbackEmbedService` wrapper; qdrant-client / engine /
  hybrid-search all resolve via the factory.

### Per-org Qdrant containers (multi-tenant isolation)
- `organizations.vector_container` column + deterministic `org_<id>` collection.
- `container-router.js`: `orgContainerName` / `resolveCollection` /
  `provisionOrgContainer` — flag-gated `QDRANT_PER_TENANT`, resolves to legacy
  `BUNDB AGENT` while off.
- `createOrgContainer()` builds the 1024-dim contract: `m=32/ef=256`, int8 quant,
  on_disk, single shard + layer/project_id payload indexes.
- Org-create hook persists `vector_container` + fires fire-and-forget provisioning
  — **never blocks/fails signup**.
- Plan-based routing: personal pool vs enterprise container + per-tenant delete cascade.

### Reliability
- Embed fetch now bounded with a timeout — no more indefinite hangs wedging ingest.

## Cutover state
Embedding dimension 384→1024 + repointing Qdrant to the 1024 box is the separate
env cutover step. The wiring is dark-safe until those env vars flip.

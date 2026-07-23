---
name: hivemind-engine
description: AUTO-USE for ANY work on the HIVEMIND memory/recall engine — recall (lanes, ranking, scope, bitemporal), ingestion & storage (hybrid Postgres+Qdrant vs .amr), the PrismaGraphStore, chat recall integration (/api/chat → runReactAgentV2), memory scoping/tenant-isolation, and the deploy/verify loop for hm-core. Read this FIRST for engine questions or changes. Companion to hyperagents (rooms) and ship (deploy). Contains a self-improving LEARNINGS LEDGER — append verified findings, never rewrite blindly.
type: reference
---

# HIVEMIND Memory Engine — recall, storage, scoping

This skill is the ground-truth map of the memory cortex + a **LEARNINGS LEDGER**
of hard-won, verified findings. Read the ledger BEFORE touching recall — most
bugs here have bitten before. Reference by symbol/file (line numbers drift).

## Loop for engine work (follow it)
1. **RECALL** — read the LEARNINGS LEDGER below + `hivemind_recall`/memory dir for prior art. Never rebuild an existing lane.
2. **SCOPE** — recall is the P0 hot path + multi-tenant. Enumerate which lanes, which stores (PG/Qdrant/.amr), which callers (`/api/recall` route vs `/api/chat` agent) a change touches.
3. **ACT** — surgical, match surrounding code.
4. **VERIFY ADVERSARIALLY** — use the deterministic harness (below), not the flaky router path. Prove the failing case, then prove the fix.
5. **PERSIST** — append a ledger entry (what/why/verified) + `hivemind_log_decision`.
6. **SHIP** — build from `/root/hivemind-main`, deploy `--no-deps core` from `/root/hivemind` (see Deploy).

## Architecture — the two entry points
There are **two recall entry points**; a change must be checked against BOTH:
- **`/api/recall` HTTP route** — `core/src/routes/recall.js` `handleRecallRoute` → builds a `RecallRouter` runtime → `router.recall(...)`.
- **`/api/chat` agent** — `core/src/server.js` `/api/chat` → `buildAccessContext(userId, orgId)` → `runReactAgentV2` (`core/src/agent/react-agent-v2.js`) → `gatherEvidence`/EvidenceBus → `dispatchTool('hivemind_recall', …)` → `tool-registry.js` `hivemind_recall` → `router.recall(...)`.

Both funnel into **`RecallRouter.recall`** (`core/src/memory/recall-router.js`) → **`recallPersistedMemories`** (`core/src/memory/persisted-retrieval.js`, impl `_recallPersistedMemoriesImpl`). That function is the shared core — fix scoping/ranking there, not per-caller.

## Recall lanes (all merged, MAX-dedup by memory id)
Run CONCURRENTLY inside `recallPersistedMemories`:
- **Vector lane** — `vectorCandidatesForRecall` → `qdrantClient.hybridSearch` (embed + Qdrant) → hydrate ids via `store.getMemories` (→ `mapMemoryRecord`, carries full fields incl. `scope`, `project_id`). Qdrant is NOT given `scope`/`project` as a payload pre-filter (project payload is null); narrow AFTER hydration on DB fields.
- **Lexical / FTS lane** — `store.searchMemories` (`prisma-graph-store.js`). For a **hybrid** org this is Postgres `to_tsvector` + optional `pg_trgm` word_similarity (flag `HYBRID_LEXICAL_RECALL`); for `.amr`/remote orgs it's `amrLexical`/`amrLexicalRemote`. **The FTS SELECT must project scope/user_id/org_id/primary_team_id/project_id/project_ids** (see LEDGER L1).
- **Entity hop-0** — `resolveEntityRecallCandidates` (`entity-hop0.js`), env `RECALL_ENTITY_HOP0`.
- **Temporal / entity additive passes** — SHOULD-mode tag passes (`TEMPORAL_FILTER_MODE`, `ENTITY_FILTER_MODE`).
- **Relationships graph** — `store.listRelationships` + typed-graph walk (`loadTypedGraphEvidence` in recall-router).

## Ranking pipeline (order matters)
Inside `_recallPersistedMemoriesImpl` after merge: relevance floor (`applyRecallRelevanceFloor`) → **scope filter** (`matchesScopeFilter`, see below) → meta/garbage-fact filters → RRF + importance/event-time/memory-type boosts → MMR → collapse near-dupes → optional Cohere rerank → `top = top.slice(0, max_memories)` → **`flatMemories = top.map(item => ({...item.memory, …}))`**.

⚠️ **Candidates are WRAPPER items `{ memory, score, vectorScore, … }` until the final `flatMemories` map.** Any post-merge filter/reader must unwrap `item.memory`, NOT read fields off the wrapper (LEDGER L2).

## Scoping & tenant isolation (the multi-tenant contract)
- **Access gate** (WHO can see it): `access_context = buildAccessContext(userId, orgId)` (`server.js`) → `{ projectIds, teamIds, orgRole, crossProject }`. Owners/admins get ALL active projects; guests are locked to explicit `projectMember` rows. Enforced per-lane (vector hydrate block, FTS WHERE tiers via `scopedMemoryWhere`, entity-hop0). This is the SECURITY boundary — never weaken it.
- **Scope lens** (WHICH tier the user asked for): `scope_filter` ∈ `personal|project|team|organization` or null. Enforced by **`matchesScopeFilter(m, scope_filter)`** at 3 points (2 per-lane + 1 post-merge choke). It infers the tier when a lane didn't hydrate `scope` (project link ⇒ project; else organization; NEVER personal — personal requires a proven scope row). `null` = ALL accessible tiers.
- **Memories page tiers** (`Memories.jsx`): `visible`(ALL) / `tier:organization` / `tier:project` / `tier:personal` via `scopedMemoryWhere` — the LIST path uses `tier:*`; the RECALL path uses plain `scope_filter`. Keep them semantically aligned.
- **Chat scope selector**: FE sends `scope` → `server.js` `requestScopeFilter` maps `all`/''→null, `organization`→'organization', `personal`/`project`/`team` verbatim → `ctx.scopeFilter` → (request scope WINS over planner) → recall. Response carries `scopes_found` (distinct tiers, project_id→name resolved) so the chat shows "(memory found in <scope>)".

## Storage modes
`memoryStorageModeFor(plan, hostingMode)` (`core/src/storage/memory-storage-policy.js`):
- **hybrid** (enterprise/managed/scale) — Postgres `memories` table (system of record + FTS lane) **AND** Qdrant collection `org_<id>` (vector lane, stored at **per-SEGMENT/chunk** granularity, so Qdrant point-count ≫ PG memory-count by design). Dual-write on ingest: `core/src/ingestion/indexer.js` (`vectorStore.upsert`) + memory row; a background **`embed-reconciler.js`** backfills Qdrant for any memory missing a vector.
- **.amr filesystem** (`amr_embedded` non-enterprise; `byod_amr` self-host) — shard at `/app/data/mneme/<org>/shard.amr`. `orgIsRemote`/`amrWrite`/`amrRecall`/`remoteHydrate`+`mapAgentRow` in the mneme driver. `getMemories`/`searchMemories` branch on `currentOrg()`+`orgIsRemote`.
- The **store** is `PrismaGraphStore` (`prisma-graph-store.js`): `getMemories` (batch hydrate, one findMany — never fan out findUnique), `searchMemories` (lexical), `getMemoryScoped`, `mapMemoryRecord` (local) / `mapAgentRow` (remote). Both mappers set `scope: r.scope || 'personal'`.

## Bitemporal
`valid_at` (world-time) + `known_at`/`transaction_at` (ingest-time). `is_latest`/`supersedes_id`/`superseded_at`; the `Updates` edge chains versions. Timeline/"previous value" walks the Updates chain (`execTimeline`); superseded rows are soft-deleted (`deletedAt`) but intentionally read on the history path. Every memory gets an ingest-time stamp (content suffix + `metadata.recorded_at` + `ts:` tag) — idempotent.

## Deterministic verification harness (USE THIS — don't trust the router path)
The full `router.recall` path is **cold-Qdrant non-deterministic** in a fresh process (returns 0 sporadically). For deterministic proof, call `recallPersistedMemories` DIRECTLY in-container:
```
# write a .mjs that imports PrismaGraphStore + recallPersistedMemories, constructs
# store = new PrismaGraphStore(new PrismaClient()), calls recallPersistedMemories(store, {
#   query_context, user_id, org_id, max_memories, access_context, scope_filter? })
docker cp probe.mjs hm-core:/app/probe.mjs && docker exec hm-core sh -lc "cd /app && node probe.mjs"
docker exec -u root hm-core sh -lc "rm -f /app/*.mjs"   # clean up after
```
- DB is schema `hivemind`, snake_case columns (`org_id`, `user_id`, `project_id`, `scope`, `deleted_at`…). Prisma models are camelCase; raw SQL needs `::uuid` casts.
- For a scope/flag question, add an env-gated `console.error` at the filter, `docker cp` the edited file over `/app/src/...` (a fresh `node` process reads disk; the running server keeps its in-memory copy — safe), run, then rebuild to restore.
- Query DB facts with a `$queryRawUnsafe` .mjs (columns via `information_schema.columns`).

## Deploy (hm-core) — baked-image compose recreate
Build tree `/root/hivemind-main` (commit here, branch `singulance-main`); run tree with `.env` is `/root/hivemind`.
```
cd /root/hivemind-main && git add <files> && git commit
export VERSION=prod-$(date +%Y%m%d)-$(git rev-parse --short HEAD)
docker compose --env-file /root/hivemind/.env -f infra/docker-compose.hetzner.yml build core     # from hivemind-main
cd /root/hivemind && docker compose --env-file /root/hivemind/.env -f infra/docker-compose.hetzner.yml up -d --no-deps core   # recreate
# wait: docker inspect hm-core --format '{{.State.Health.Status}}' == healthy
```
- Write a rollback marker first: `echo <prev-image-tag> > /root/hivemind/.last-core-<name>-rollback`.
- Build fails with "env file not found" if run from hivemind-main without `--env-file /root/hivemind/.env`.
- This is the baked-image path (NOT `quick-deploy.sh`, NOT `scripts/deploy-fe.sh`). Prefer the `ship` skill when it fits.

## LEARNINGS LEDGER (append verified findings; newest on top)
- **L2 — post-merge scope filter read the WRAPPER, not the memory** (2026-07-23, VERIFIED, shipped `7b5c2c45d`). At the post-merge choke point `filtered` holds `{memory,score,…}` wrappers; the flatten happens later. Reading `m.scope` off the wrapper → undefined → inferred 'organization' → dropped the WHOLE pool (project lens=0; personal=0 by dropping everything = false "works"). Fix: `matchesScopeFilter` unwraps `m.memory` when present. Per-lane checks pass flat memories and are unaffected.
- **L1 — FTS/lexical lane dropped scope + project fields** (2026-07-23, VERIFIED, shipped `73892ca7c`). `searchMemories`' central-Postgres FTS `$queryRawUnsafe` SELECT + row-map omitted scope/user_id/org_id/primary_team_id/project_id/project_ids — only the vector lane (getMemories) hydrated them. So FTS-sourced memories were scope-less and leaked across the scope selector. Fix: add the columns to the SELECT (`project_ids` via `array_agg` over `memory_projects`) + the mapping. WHERE-clause tenant scoping was already correct → delivery-shape only, no access change. See [[scope-filter-enforcement-fix]].
- **Scope inference rule** — never infer `personal` for a scope-less row (personal must be proven); infer `project` iff a project link exists, else `organization`. Mirrors the access-context filter — keep the two in sync.
- **Hybrid = per-segment Qdrant** — Qdrant points ≫ PG memories is NORMAL (documents chunk into many segment vectors; PG holds canonical memories). Not a missing write. Verify dual-write via `indexer.js` + `embed-reconciler.js`; the launch-memory test confirmed presence in BOTH stores.
- **Recall-ranking non-determinism** — the router path is cold-Qdrant flaky; anchor timeline/verification on the entity/DB directly, use the direct `recallPersistedMemories` harness as the oracle. Keep-warm warms ACTIVE orgs (cold ~2600ms → ~650ms; warm floor ~640ms is remote-Qdrant-bound).
- **Data can be scattered across orgs** — the same docs ingested under different session orgs live in different tenants (each ingest writes only the session's org; no cross-org dual-write). A memory missing under org-wide is often a wrong-session-org problem, not a recall bug.
- **update-tool failures were invisible** (2026-07-23, shipped `d7daea5da`) — `hivemind_update_memory` returned structured `{updated:false}` / threw with no server log. Now warn-logs each hard failure + try/catch around `ingestMemory` returns `update_write_failed` with detail. When debugging "update failed in chat", grep `docker logs hm-core` for `[hivemind_update_memory]`.

## Cross-refs
- Deploy: `ship` skill. Rooms/agents that CONSUME recall: `hyperagents` skill. Qdrant ops: `qdrant-ops`. Repo memory: `hivemind_recall` + `/root/.claude/projects/-root-hivemind/memory/`.

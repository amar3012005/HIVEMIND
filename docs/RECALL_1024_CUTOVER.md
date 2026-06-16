# Recall 1024 / bge-m3 Cutover + Two-Qdrant Split-Brain Fix

**Date:** 2026-06-16
**Scope:** production recall pipeline (org `f5e2418b` "HIVEMIND" + all 14 orgs)
**Outcome:** recall moved from broken Postgres keyword-fallback (~4s, low accuracy) to real
1024-dim bge-m3 per-tenant vector search. Solvis combo@8 = **1.00**.

---

## 1. The symptom

`/api/recall` returned `search_method: persisted-keyword`, ~4s latency, weak semantic recall.
Tara / `/chat` / MCP / search all degraded (they share the same core).

## 2. Root cause — a two-Qdrant split-brain + stale 384 env

There are **two** Qdrant instances:

| Instance | What it held | Pointed at by hm-core? |
|---|---|---|
| **Qdrant Cloud** (`24826665….eu-central-1-0.aws.cloud.qdrant.io`) | legacy **384** collections (`BUNDB AGENT` 14729 pts, `HIVEMIND_PERSONAL` 31) | **YES** (`QDRANT_URL`) |
| **hm-qdrant** (self-hosted, on-box, net `hmtest`, bind `/opt/HIVEMIND/qdrant-data`, v1.12.4, key `dd9c…`) | the real **1024 bge-m3 per-tenant** containers — 11× `org_<id>` | **NO** (stranded) |

The 1024 bge-m3 per-tenant migration had been built and partially backfilled — **on hm-qdrant** —
but at some point hm-core's `QDRANT_URL` was pointed at **Cloud**. Since then:

- All writes went to Cloud's legacy 384 single-collection. hm-qdrant froze (stale).
- The query embedder was `EMBEDDING_PROVIDER=mistral` → **384-dim** vectors.
- `QDRANT_PER_TENANT` was unset → router returned legacy `HIVEMIND_PERSONAL` regardless of plan.

Net: query (384) vs collection (1024) mismatch + wrong/near-empty collection →
**vector search failed → Postgres FTS keyword fallback** → 4s + degraded recall.

The code uses a **single** `QDRANT_URL` (no dual-instance awareness), so whichever URL is in env is
the only instance touched.

## 3. The fix (canonical = hm-qdrant, on-box, lowest-latency)

All env in `/data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/.env`:

```
QDRANT_URL=http://hm-qdrant:6333          # repoint: on-box 1024 instance (no internet RTT)
QDRANT_API_KEY=dd9c633f…
QDRANT_PER_TENANT=true                     # router honours org_<id> containers
EMBEDDING_PROVIDER=litellm                 # bge-m3 1024 via blaiq (api.blaiq.ai)  — PRIMARY
EMBEDDING_FALLBACK_PROVIDER=openrouter     # baai/bge-m3 1024                      — FALLBACK
EMBEDDING_DIMENSION=1024
# PURGED (no 384/mistral trace): EMBEDDING_MODEL_NAME, EMBEDDING_API_KEY,
#                                EMBEDDING_MODEL_URL, MISTRAL_*, QDRANT_COLLECTION
```

`getEmbedService()` now returns a `FallbackEmbedService` (litellm primary → openrouter fallback),
both bge-m3 1024 → vectors interchangeable.

### Data backfill (PG is source of truth)

1. **Memories** — `core/scripts/reembed-pg-to-qdrant.mjs --commit`
   Re-embedded **12,168** latest memories → their `org_<id>` container @1024 (idempotent upsert;
   closed the freshness gap from the stale hm-qdrant). `failed=0`.
2. **Evidence segments** — `core/scripts/reembed-segments-to-qdrant.mjs --commit` (new)
   Embedded **6,877** `KnowledgeSegment`s into the **same** `org_<id>` container with
   `layer=evidence` (mirrors `DocumentFirstIngestion._embedSegments`). One container, filtered by
   layer — no separate `hivemind_evidence` collection. `failed=0`.
   → evidence HOP2 dropped from a ~0.86s Postgres fallback to a **~40ms** in-container vector hit.

### Result

- `search_method: persisted-hybrid` (vector lane live, was `persisted-keyword`)
- Solvis fine-detail eval (`recall-solvis-eval.mjs`): **fact@8 0.90 · evid@8 0.40 · combo@8 1.00 · MRR 0.79**
- Project-scoped + global-scoped recall + evidence all return.
- hm-qdrant: every collection is **1024**; no 384 on the live path.

## 4. Env-drift killed (the deeper root cause)

The split happened because the two replicas (`hm-core`, `hm-core-2`) were started by independent
`docker run`s with **independent env sets** — one got Cloud, the other never updated. Worse, they
had **silently diverged on recall config**:

- `OPENROUTER_API_KEY` + `RERANK_*` (cross-encoder) were **only on hm-core** → cross-encoder rerank
  was OFF on hm-core-2 (half of traffic, lower accuracy).

Fix — **single canonical env, both replicas load it; singletons in per-replica overlays:**

- `…/.env` = the one shared source (qdrant, embedding, rerank, redis, db, …). Drift now impossible.
- `/opt/HIVEMIND/sing-hm-core.env`   → `HERMES_MANAGER_ENABLED`, `BACKUP_S3_*`
- `/opt/HIVEMIND/sing-hm-core-2.env` → `ENABLE_GOVERNANCE_SCHEDULER` (cognition cadence owner),
  `SLACK_*` (socket bridge)

Each container: `--env-file …/.env --env-file <its overlay>`. Singletons run on exactly one replica
(no double Slack bridge / double manager / double scheduler). RERANK now on **both**.

## 5. Recall optimizations — all ON, none disabled (BE + FE)

All surfaces (Tara, `/chat`, Overview, search, MCP) flow through the same
`recallPersistedMemories` core. Flags + defaults:

| Optimization | Flag | State |
|---|---|---|
| Candidate pool floor (150) | `RECALL_CANDIDATE_POOL` | ON |
| Tiered term-overlap reranker | `RECALL_TIERED_VIEW` | ON (default) |
| Cross-encoder rerank (Cohere v3.5) | `RERANK_ENABLED` | ON, both replicas |
| Cross-lingual query expansion (llama-8b) | `RECALL_QUERY_EXPANSION` | ON |
| Entity-targeted lane (llama-8b extract) | `ENTITY_LLM_EXTRACT` / `ENTITY_FILTER_MODE=should` | ON |
| Dreams-first boost | `RECALL_DREAMS_FIRST` | ON |
| Event-time ranking | `EVENT_TIME_RANKING` | ON |
| HNSW ef_search 200 | `QDRANT_HNSW_EF` | ON |
| int8 quant **rescore** | `QDRANT_QUANT_RESCORE` | OFF — intentional (was a 4s killer; quant still used for storage) |

## 6. Latency characterization (warm `/api/recall`, ~2.6s)

Measured via env-gated stage laps (since reverted). Entire cost is **inside
`recallPersistedMemories`** (enhance/evidence/live = ~40ms, access = cached):

| Stage | ~ms | Note |
|---|---|---|
| lexical (Postgres FTS lane) | 500 | sequential, independent of vector |
| base vector fetch | 400 | embed 130 + qdrant 70 + overhead |
| query expansion + variant fetches | 120 | |
| `expandCandidatesViaGraph` | 690 | graph neighbour blow-up |
| **sync tail** (merge/score/dedup/rerank/synthesis over the expanded pool) | **~1400** | pure JS, no awaits — the prize |

## 7. Final pieces

### Done (2026-06-16 hardening pass — production)
- ✅ **Durable launch.** systemd `hm-core.service` → in-repo `scripts/hm-core-start.sh` (both
  replicas from one canonical `.env` + overlay; refuses to start on a non-`hm-qdrant` `QDRANT_URL`).
  Reboot-safety proven (`systemctl restart` → both back @ hm-qdrant/1024). Stale Cloud/384 launcher
  env (`.runtime/hm-core.env`) neutralized. *(Was the real prod risk: the cutover lived only in
  running-container memory and would have reverted on the next restart/reboot.)*
- ✅ **Accuracy independently re-verified** — Solvis `recall-solvis-eval.mjs`: combo@8 **1.00**,
  fact 0.90, MRR 0.79.
- ✅ **Fresh-ingest path proven** — a new `/api/memories` write embeds @1024 and lands in its
  `org_<id>` container (count +1; 1024 enforced by Qdrant) and is immediately recallable. Ongoing
  writes use the new lane, not just the one-time backfill.
- ✅ **All cutover artifacts version-controlled** — `reembed-pg-to-qdrant.mjs`,
  `reembed-segments-to-qdrant.mjs` (was box-only), `recall-solvis-eval.mjs`, this doc, the launcher,
  the systemd unit.
- ✅ **Latency safe-win** — parallelized the independent lexical ‖ base-vector lanes
  (`persisted-retrieval.js`). Warm `/api/chat` **~5.0s → ~3.1s**. Eval-gated: combo@8 stayed **1.00**.

### Deliberately deferred (need supervision / consent — NOT auto-run)
1. **Cap the graph-expanded candidate pool** before the ~1.4s synchronous merge/score/rerank tail
   (~–1s). This changes *what* gets scored → accuracy-sensitive. The 10-query Solvis eval is too
   coarse to clear it alone; needs a supervised A/B across more queries/tenants. Do NOT ship blind.
2. **Legacy Cloud 384 cleanup** — the disconnected Cloud Qdrant still holds the old 384 collections.
   Already out of the active path (no replica references it; launcher guards against repointing) and
   PG is the source of truth, so it costs only money + "384 trace." Deleting an external data store
   is destructive → requires explicit owner sign-off + a snapshot first. Not auto-executed.
3. **FE surfaces click-through** — backend is unified and verified (live `/api/chat` returns grounded
   1024 recall); the Tara/Overview/search UIs call the same core. Just needs a human live click.

## 8. Operational notes

- **Launch is now durable (systemd + version-controlled script).** `hm-core.service`
  (`/etc/systemd/system/hm-core.service`, enabled) → `ExecStart=/opt/HIVEMIND/scripts/hm-core-start.sh`
  (in-repo, survives `git pull`). The script recreates BOTH replicas via
  `docker run --env-file <canonical .env> --env-file <per-replica overlay>` and **refuses to launch
  if the canonical `QDRANT_URL` isn't `hm-qdrant`** (guards against re-introducing the Cloud/384
  split-brain). Reboot / `systemctl restart hm-core` reproduces the exact verified config.
  - Rolling restart one replica: `/opt/HIVEMIND/scripts/hm-core-start.sh hm-core-2`.
  - Canonical env: `/data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/.env`.
    Overlays: `/opt/HIVEMIND/sing-hm-core.env`, `/opt/HIVEMIND/sing-hm-core-2.env`.
  - The OLD stale launcher env (`/opt/HIVEMIND/.runtime/hm-core.env`, which still held
    `QDRANT_URL=Cloud` + `EMBEDDING_DIMENSION=384` + mistral) was renamed
    `…hm-core.env.STALE-CLOUD384-DONOTUSE` so nothing can source it.
- `docker restart` reloads bind-mounted code but **not** `--env-file` changes — env changes require
  recreate (use the launcher).
- hm-qdrant is persistent (`/opt/HIVEMIND/qdrant-data`). It is the canonical vector store. Do **not**
  repoint `QDRANT_URL` back at Cloud.
- Backfill scripts are idempotent (point id == memory/segment id). Safe to re-run.

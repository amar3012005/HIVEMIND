# Recall — final state, what was broken, what we fixed

_Last updated 2026-07-23. Live: `core-api:prod-20260723-caa3fb10d` on `singulance-main`._
_Standing rule that drove this: right context on top, deterministic, low-latency, one engine,
FE contracts (`/api/recall`, `/api/chat`) never changed._

## TL;DR
The complaint was "the highly-relevant memory never lands in the top 5" (e.g. *"when is the
launch date of solvis pia?"* answered "no launch date in evidence" even though the memory
existed). After two days of tuning **ranking**, the real cause turned out to be **retrieval
plumbing**, not ranking. Five distinct problems were found and fixed. Recall now puts the
right memory #1, deterministically, through a single engine, with drift auto-healed.

## The one-line root cause
Memories were written to Postgres but a large fraction were **never embedded into Qdrant**, so
the semantic half of the hybrid was blind to them — only the lexical lane could see them, and a
terse lexical-only memory got out-ranked by content-rich document evidence and dropped before
top-k. The ranking pipeline (RRF + boosts + tiered reranker + Cohere) was fine all along.

---

## Problems found (in order of discovery) + fixes

### 1. Chat searched with the RAW prompt, not an optimised query
- **Issue:** `gatherEvidence` led the recall packet with the raw `plan.user_message`
  (joined onto sub-queries via `"\nRelated focus: "`), so memory was searched with
  conversational filler ("when is the launch day for…") and, for non-English input, a query
  in a language the store isn't in ("was ist der Umsatz von Solvis?"). Both tank retrieval.
  A dead `plan.query_canonical_en` field existed but was never populated.
- **Fix:** `optimizeRecallQueries` (react-agent-v2.js) rewrites the message into 1–3 short
  English keyword queries (entity + attribute), translating non-English, and sets
  `plan.query_canonical_en`. Main packet + escalation now lead with it. Filename queries
  preserved for the tag exact-match path. Answer LLM still sees the user's original wording.
- **Shipped:** `prod-20260722-2b29cf144`.

### 2. Drift — memories not embedded into Qdrant (THE root cause)
- **Issue:** embedding is a decoupled `storeMemory` step that only *some* of the ~16 save
  paths call. Document-ingestion facts embedded; TARA-call summaries, chat-save, and
  connector-email wrote to Postgres and **never embedded**. Audit: **~21% of MANDI's
  memories missing from Qdrant; one org 100% missing.** The launch memory was 404 in the
  vector store — invisible to semantic recall.
- **Proof it was drift, not ranking:** embedding the launch memory made it **rank #1 in the
  vector lane** (0.724) and **#1 end-to-end** through the full pipeline. Cohere rerank
  confirmed firing (reorders it to #1 in ~300ms). So candidates, not ranking, were the gap.
- **Fix (path-independent, permanent):**
  - `core/src/memory/embed-reconciler.js` — a background worker (every 3 min + hourly full
    sweep) that finds PG memories missing from their org's Qdrant collection and embeds them
    via the same `storeMemory` pipeline, with retry + loud log. Mounted in `server.js`
    (`EMBED_RECONCILE_ENABLED`, default on). Any save path that forgets to embed is auto-healed.
  - `qdrant-client.storeMemory` hardened: retries transient embed failures; on hard failure
    it **skips the upsert + logs loud** instead of writing a placeholder vector (a placeholder
    looked "present" and was never re-embedded — silent recall poison).
  - **Backfill:** 104 missing embeddings across 4 orgs cleared (idempotent).
- **Shipped:** `prod-20260723-15cc12aa0`.

### 3. Two recall stacks → "which engine am I tuning?"
- **Issue:** the chat/product path (`recallPersistedMemories` in persisted-retrieval.js +
  recall-router.js) and a **parallel** ThreeTier/hybrid stack (`search/hybrid.js`,
  `three-tier-retrieval.js`, …) serving `/api/search/*`. Tuning one didn't affect the other,
  and external analysis (Grok) pointed at the *wrong* file (`search/hybrid.js`) — which
  literally cannot affect chat. Confirmed: `persisted-retrieval` explicitly bypasses both
  `hybrid.js` files; chat uses `/api/recall`, the FE never calls `/api/search/*`.
- **Fix:** routed **all** `/api/search/{quick,panorama,insight,compare}` + the pageindex
  fallback through the single canonical `recallPersistedMemories` (`quick` was already done).
  Removed the `ThreeTierRetrieval` instantiation/import from the server bundle. Then deleted
  the duplicate outright — **18 files** (ThreeTier/hybrid engine ×2 dirs, dead barrels, the
  offline `retrieval-evaluator` harness + `/api/evaluate/*` endpoints, orphaned utils). Kept
  the shared `search/` utilities the live engine uses (`result-reranker`, `query-rewriter`,
  `fusion`, `pageindex-searcher`, …) and the longmemeval/dataset tools.
- **Shipped:** collapse `prod-20260723-6cdf9203b`; deletion `prod-20260723-79b9a9d88`.

### 4. Non-deterministic ordering ("sometimes works, sometimes not")
- **Issue:** equal-score candidates reordered run-to-run; the delivered top-k could flip.
- **Fix:** stable id tie-break on the two load-bearing sorts (merge + final delivery) in
  persisted-retrieval — `score desc, then id`. Verified identical across repeated runs
  (rerank on AND off). The only residual movement was cold-start cache warm-up.
- **Shipped:** `prod-20260723-6cdf9203b`.

### 5. Cohere reranker silently dropped under burst
- **Issue:** the cross-encoder abort budget (`RERANK_TIMEOUT_MS`) was 1500ms. Cohere-via-
  OpenRouter is ~300ms normally but spikes to 1–2s under burst/queueing → it aborted and
  degraded to algorithmic order **exactly when load was highest** (`[reranker] degraded …
  operation was aborted`).
- **Fix:** raised default to 2500ms + one transient retry (abort/timeout/429/5xx); non-
  transient errors degrade immediately (no load amplification); graceful degrade kept as the
  final safety net. Verified: 4 parallel recalls keep launch memory #1 with zero degradations.
- **Shipped:** `prod-20260723-caa3fb10d` (current).

---

## How recall works now (the single canonical engine)
`/api/recall` and `/api/chat` → **`recallPersistedMemories`** (persisted-retrieval.js) + RecallRouter.
Parallel hybrid lanes → fusion → ranking → rerank → deliver:
1. **Lanes (parallel):** Qdrant dense vector (per-tenant `org_<id>` collections, HNSW, int8
   quantization) · Postgres FTS (`to_tsvector('simple', title||content)`, GIN) · pg_trgm
   trigram (`public.word_similarity > 0.4`) · entity-hop0 · temporal · graph-expansion
   (memory_relationships table, recursive SQL — NOT Apache AGE) · crosslingual expansion.
2. **Fusion:** `mergeCandidateLists` (MAX-score merge) → sort **score desc, id tie-break**
   (deterministic) → keep a WIDE rerank window (~50, not the delivered N).
3. **Rank/rerank:** `ResultReranker` (tiered) → **Cohere `rerank-v3.5` via OpenRouter**
   (RERANK_ENABLED, 2500ms + 1 retry) → slice to N → head-slot (canonical/bridge first).
4. **Query:** searched with the optimised English keyword query (§1), not the raw prompt.
Chat surfaces the delivered memories/evidence to synthesis, which grounds on citation packets.

`/api/search/*` now calls the SAME engine. There is **one recall implementation** on disk and
in the runtime — nothing to mis-tune.

## LLM providers (context; separate track, already shipped)
Canonical config is `core/src/llm/llm-config.js`: **Cerebras (primary) → OpenRouter
(failover), single `gpt-oss-120b`, no Groq/llama** for text. All chat/recall/ingestion LLM
calls route through the `groq-fallback` chokepoint. `reasoning_effort:low`. See
[llm-provider-config.md](../memory/llm-provider-config.md). (Shipped `prod-20260722-c96ff778b`.)

## Verified (live, on the deployed image)
- *"when is the launch date of solvis pia?"* → launch memory **#1**, top-5 stable
  `8df84dd9,88edd6e6,80d66afa,2a1eb306,4f95cbf3`.
- Recall **deterministic** across repeated runs (rerank on/off).
- Reconciler steady-state: 0 missing (backlog cleared; auto-heals new drift ≤3 min).
- Cohere reranker fires (~300–500ms); 4 parallel recalls, no degradation.
- 21/21 in-image contract tests green on every deploy.

## Deploy / rollback ledger (this effort)
| Change | Prod tag | Rollback marker file |
|---|---|---|
| update_memory resilience | prod-20260722-dd0fcf9a4 | .last-core-*-rollback |
| LLM canonical (Cerebras→OpenRouter) | prod-20260722-c96ff778b | .last-core-llm-canonical-rollback |
| query optimiser | prod-20260722-2b29cf144 | .last-core-queryopt-rollback |
| embed-reconciler + hardened embed | prod-20260723-15cc12aa0 | .last-core-drift-fix-rollback |
| collapse to one engine + determinism | prod-20260723-6cdf9203b | .last-core-collapse-rollback |
| delete duplicate + eval harness | prod-20260723-79b9a9d88 | .last-core-deldup-rollback |
| reranker timeout + retry | **prod-20260723-caa3fb10d (LIVE)** | .last-core-reranker-rollback |

Deploy = build image from a **singulance-main** git worktree → bump `VERSION` in
`/root/hivemind/.env` → `docker compose --env-file /root/hivemind/.env -f
infra/docker-compose.hetzner.yml up -d core` (the `--env-file` is mandatory — see
[deploy-topology.md](../memory/deploy-topology.md)).

## Open follow-ups (non-blocking)
- Drift was fixed via reconcile, not by fixing each save path to embed inline. If inline
  latency matters, wire embedding into the create chokepoint too (reconciler stays as the net).
- The durable end-state for the dual-write class of bug is **pgvector unification** (atomic
  row+vector writes make drift impossible) — scoped in the earlier discussion; not done.
- Residual synthesis non-determinism is LLM-level (query rewrite); structural causes closed.

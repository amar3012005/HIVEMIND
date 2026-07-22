# Recall pipeline — how it actually works + what shipped

## Two delivery paths (both real, keep both working)
- **Engine:** `recallPersistedMemories` in `core/src/memory/persisted-retrieval.js`.
- **Router:** `RecallRouter.route` in `core/src/memory/recall-router.js`.

## Hybrid retrieval lanes (run in PARALLEL — this is the design, don't collapse it)
1. **Qdrant dense vector** — per-tenant collections, HNSW m=32/ef_construct=256,
   int8 scalar quantization always_ram, on_disk vectors+payload, ef_search=200,
   indexed payload filters. Built for millions of docs / enterprise scale.
2. **Postgres FTS** — `to_tsvector('simple', title || ' ' || content)` +
   `to_tsquery('simple', …)`, title-first, GIN-indexed. (No pgvector; Postgres is
   the lexical leg, Qdrant is the vector leg.)
3. **pg_trgm trigram** — `public.word_similarity(...) > 0.4` (schema-qualified — see fix below).
4. entity-hop0, temporal, graph-expansion, crosslingual lanes.

## Fusion + ranking (the order that matters)
- `mergeCandidateLists` = the REAL fusion (MAX-score merge across lanes).
- `reciprocalRankFusionMemories` (RRF_K=60, writes `_rank_score`) is effectively
  decorative/nullified downstream — know this before "fixing" RRF.
- `ResultReranker` (`core/src/search/result-reranker.js`), `RECALL_TIERED_VIEW` default ON,
  is the terminal ranker and **overwrites `.score`** with a generic 5-signal formula
  clamped [0,1] → this NULLIFIES upstream boosts. **This was the #1 defect.**
- Cross-encoder rerank: `core/src/search/reranker.js`, Cohere `rerank-v3.5` **via OpenRouter**
  (`RERANK_ENABLED`, `RERANK_API_KEY` set). NOT a direct Cohere key — it's OpenRouter.

## Fixes that SHIPPED this session (all live in prod-20260722-rmye01367541)
1. **pg_trgm 42883 silent degradation (root cause, days-old):** unqualified `word_similarity`
   threw under Prisma's hivemind-only `search_path`, was caught silently → the whole lexical
   lane degraded quietly. Fixed: `public.word_similarity`, explicit `> 0.4` threshold, and a
   LOUD `console.warn('[recall] FTS/trigram lane failed…')` so it can never fail silent again.
   (`prisma-graph-store.js` `searchMemories` ~937.)
2. **FTS index orphaned + expression mismatch:** the old GIN index was on an empty
   `public.memories`; real data is in `hivemind.memories`. Query was seq-scanning. New
   migration `20260722160000_recall_scale_fts_indexes` drops the orphan and creates
   `memories_fts_simple_idx` (+ knowledge_segments FTS + trigram GIN) on the `hivemind`
   schema, aligned to the `'simple'` title-first expression. EXPLAIN now shows Bitmap Index Scan.
3. **rerank-nullification guard:** `sortWithImportanceTiebreaker` after the cross-encoder is
   now guarded `if (!_crossReranked …)` so the terminal sort can't clobber cross-encoder order.
   Plus a rare-token IDF boost after `mergeCandidateLists` (gated `HYBRID_LEXICAL_RECALL`,
   `HYBRID_RARE_ALPHA` default 0.6). (`persisted-retrieval.js`.)
4. **Evidence citability:** base recall returned `evidence[]` but no `evidence_packet`, so KB
   segments were not citable and KB-prose questions failed. Added `bus.addPacket({citations:
   r.evidence.slice(0,8)…})` in `react-agent-v2.js` ~653. Verified KB-prose now answers.
5. **`'simple'` FTS config** everywhere = multilingual (EN+DE) without a language guess.

## Data location gotchas (bit us before)
- Real memories live in the **`hivemind` schema**, NOT `public`. `public.memories` is empty;
  `raw regclass` checks lie. `user_profiles` table IS real despite regclass.
- `.amr` / mneme native engine (B2C personal): dense-only HNSW, NO native sparse/BM25; its
  hybrid lexical leg is agent-Postgres (remote) or a JS substring scan (local sole).
  `MNEME_MODE=dual`, `MNEME_PERSONAL_DEFAULT=1`. The hybrid must also work under `.amr`.

## Considered-and-parked
- `deliverUnifiedV2` (RRF-fuse mem+evidence → cross-encoder → amplitude boosts pinned×2 /
  synthesis×1.3 / event-time×1.4 / superseded×0.5) is WIRED behind `RECALL_UNIFIED_V2`
  (default OFF, timeline-exempt). A/B showed no rank win + added latency → left OFF. Don't
  turn it on without a fresh A/B.

## When you touch recall
- `hivemind_recall_bugs` + `hivemind_why_code` FIRST.
- Never report green without a live cold test. Match on normalized whitespace, not literal spaces.
- The characterization/contract tests are the safety net for the hot path — keep them green.

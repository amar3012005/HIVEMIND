# 03 — Recall

Landed **Jun 4–5**. Theme: retrieve wide, deliver narrow, and make the delivery
knobs tunable per-org so the evolution loop can close on them.

## Commits

| SHA | Summary |
|-----|---------|
| `3a63987` | deliver top-5 (retrieve-wide-deliver-narrow) — env `RECALL_DELIVER_LIMIT` |
| `cf3dc1a` | cross-encoder reranker (Stage 4/P1) — wired, gated OFF by default |
| `feb5b69` | wire RetrievalConfig score_threshold into recallPersistedMemories |

## What was built

### Retrieve-wide-deliver-narrow
- HOP1 still fetches up to 50 + RRF/MMR/salience rank — but only **top-5** ranked
  memories go to the answer model (was 15).
- Rationale: 1024-dim bge-m3 + algorithmic rerank show a clean relevance cliff
  after ~5; ranks 6–10 were measured to be redundancy/junk.
- Tunable via `RECALL_DELIVER_LIMIT` without redeploy.

### Cross-encoder reranker (ship-ready, dark)
- `reranker.js`: retrieve-wide → cross-encoder rerank pool (cap 200) → deliver top-N.
- Supports **TEI** (self-host BGE-reranker-v2-m3) + **Cohere Rerank**.
- **Never throws** — graceful degrade to algorithmic order on error/timeout.
- Gated by `RERANK_ENABLED` (default false) = pure no-op, zero latency impact.
- Posture: ship-ready-but-off until a GPU cross-encoder endpoint exists (CPU
  cross-encoder would blow the p95 budget).

### Per-org score threshold (closes the evolution loop)
- `/api/recall` + all `recallPersistedMemories` callers read the per-org
  `score_threshold` from `RetrievalConfig` (fallback 0.20).
- This is the knob the [evolution loop](./04-cognition-governance.md) tunes and
  measures via Recall@K. Temporal queries keep the 0.15 floor.

## Pipeline shape (current)
```
query → lexical(FTS/GIN) + vector(Qdrant ANN, HNSW ef tunable)
      → RRF merge → MMR diversity → salience/importance boost → cluster boost
      → [reranker if RERANK_ENABLED] → deliver top-RECALL_DELIVER_LIMIT
```

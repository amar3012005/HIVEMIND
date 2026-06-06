# 02 — Memory Engine (core)

The "10M roadmap" P2–P6 hardening pass + a string of P2010 crash fixes. Landed **Jun 2**.

## Commits

| SHA | Summary |
|-----|---------|
| `b05e8c2` | P2 activate salience scoring (importance_score + recall feedback) |
| `a9d3846` | P2 reinforce salience on agent + MCP recall path |
| `c050c27` | P3 selective vector forgetting + isLatest demotion in drift compaction |
| `7b3d5ba` | P3 purge by Qdrant point id (not memory_id filter) |
| `46c9a5e` | P4 search-time HNSW ef control (recall/latency dial) |
| `d267fe9` | P5 GIN index matching the primary FTS recall expression |
| `0efb7a1` | P6 minimal eval + telemetry |
| `0451743` | Stage-2 embed canonical summaries + honest vector-drift metric |
| `0bdb9f3` | drift metric NON_EMBEDDED_TYPES = conversation only |
| `c4949dc` | hard-delete vector purge by point id |
| `ee772a3` | kill P2010 tx-timeout under bulk promote (advisory-lock contention) |
| `c1b15df` | instrument + self-heal sourceMetadata JSONB failures |
| `9059324` | strip unpaired UTF-16 surrogates in stripNullBytes (P2010 hex-escape) |
| `cce93fa` | remove blanket every-turn conversation-log auto-save |

## What was built

### Salience loop (P2) — closes "salience = constant" failure mode
- `importance_score` was a flat `0.5` for ~99% of rows and **never consumed** in
  ranking (formula used a constant `1`).
- Now `computeImportanceScore(memory_type, priority)` sets a real content-derived
  score at ingest, upgraded once the processor extracts low/medium/high priority.
- Recall consumes it: `applyClusterBoost` applies an importance multiplier
  centered on 0.5 (legacy rows stay neutral ×1.0; a 0.85 decision → ×1.14, a 0.1
  throwaway → ×0.84).
- Recall feedback: every recall hit increments `recall_count` + nudges `strength`
  alongside the `lastAccessedAt` bump.

### Selective vector forgetting (P3) — closes "compaction starvation"
- Drift-compaction built a lossless canonical summary but never demoted the
  folded sources → they stayed `isLatest=true`, requalified into the 500-row pool
  every tick forever, and their redundant vectors polluted ANN recall.
- Now after `Derives` edges are written: demote `isLatest=false` + set
  `supersedesId=canonical`, and **purge their Qdrant points** (`purgeVectorsByMemoryIds`).
  Zero info loss (summary contains them verbatim); rows survive for time-travel.

### Honest vector-drift metric
- Diagnosed a phantom "-278 drift": conversation/observation/summary types had
  **zero vectors by design** (born via direct `prisma.create`, never embedded).
  The metric was a scope lie, not a recall break.
- Fix: cognition-loop now embeds canonical summaries (the one genuine miss); the
  drift gauge measures **embeddable rows only**.

### Reliability (P2010 hex-escape crashes)
- Strip unpaired UTF-16 surrogates + NUL/control chars before JSONB writes.
- Self-heal + instrument `sourceMetadata` JSONB failures.
- Kill tx-timeout under bulk promote (advisory-lock contention).

### Hygiene
- Removed the blanket every-turn conversation-log auto-save (was flooding the graph with noise).

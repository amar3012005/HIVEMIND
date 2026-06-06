# 04 — Cognitive Layer & Governance Agents

The cron-driven self-improvement brain. Governance agents **Faraday** (observe),
**Feynman** (reason), **Turing** (reconcile) run the cognition loop. Landed **Jun 4–5**.

## Commits

| SHA | Summary |
|-----|---------|
| `3923ea7` | Phase 0 — cheap writer model + Faraday signal-gate (stop token bleed) |
| `b12b8fc` | Phase 1 A2 — grounded bridges (anti-hallucination) |
| `205bda4` | Phase 2+3 — self-evolving retrieval loop (RetrievalConfig + AutoResearch) |
| `24bd367` | evolution: rule-based deterministic propose (0 tokens, reliable) |
| `84e7b78` | drift-compact vector purge routes per-tenant (forward purge gap) |
| `f18d7fb` | eval CLI main-guard so importing evalOrg() doesn't trigger CLI run |

## What was built

### Phase 0 — stop the token bleed
- Synthesis/compaction writing moved to **llama-3.1-8b-instant**
  (`COGNITION_WRITER_MODEL`), ~30–60× cheaper than gpt-oss-120b. Routine cron
  text is high-volume/low-reasoning → cheap model; fallback gpt-oss-20b.
- **Faraday signal-gate**: `runFullCycle` now gates the LLM-heavy Feynman+Turing
  on Faraday observations ≥ `GOV_MIN_FARADAY_SIGNAL` (default 1). Previously they
  ran every cycle even on zero observations → burned ~1M tokens/agent/day →
  exhausted the budget → **all cycles skipped**. Gate prevents re-exhaustion;
  budget self-resets daily.

### Phase 1 — grounded bridges (anti-hallucination)
- Bridges previously fired on **centroid cosine alone** → coincidental/tautological
  links ("US contacts share country:usa with US accounts").
- Now a bridge candidate must share ≥ `BRIDGE_GROUND_MIN` **real entities**
  (`entity:`/`person:` tags) between clusters — the shared entity IS the actual
  enterprise connection. Cosine becomes a secondary relevance band.
  `grounded_on_entities` provenance stored per bridge for audit.

### Phase 2+3 — self-evolving retrieval loop (EvolveMem)
- **`retrieval_config`** table = per-org action space (deliver_limit,
  score_threshold, hnsw_ef, ranking weights). `applyDelta` clamped to safe bounds.
- **`task_outcome`** log fired fire-and-forget on every recall (query / returned_n
  / top_score) = the **0-token feedback signal**.
- **`evolution-engine.js`** mapped to governance roles:
  `diagnose` (SQL stats, 0 tokens) → `propose` (rule-based deterministic delta,
  0 tokens) → **verify gate** (replay memory-eval Recall@K before/after, COMMIT
  iff recall not regressed & p95 within tolerance, else REVERT) →
  `retrieval_evolution` audit row. `delta_hash` dedupe = never re-propose a
  rejected delta. **Capability-preserving by construction.**
- Gated `EVOLUTION_ENABLED` (default OFF = dark). Recall config consumption is
  live + safe (defaults = pre-Phase-2 behavior).

## How this strengthens recall over time
The loop is a closed control system: every recall emits a cheap outcome signal →
nightly diagnose reads aggregate stats → proposes a bounded config delta →
**proves it on the eval harness before committing** → audits the change. Recall
quality ratchets up without human tuning and **cannot regress** (verify gate
reverts any delta that drops Recall@K).

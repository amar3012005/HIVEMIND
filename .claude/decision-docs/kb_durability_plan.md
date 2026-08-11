# KB Ingestion — Durability Hardening Plan (ONE plan, resolve everything)

_Authored 2026-08-05. Goal: make the EXISTING pipeline supermemory-grade **robust** —
not a re-architecture. Once a file is accepted, the pipeline reliably delivers, and
**verifies it delivered**, finished: evidence segments (all embedded) · memories (or an
honest evidence-only degrade) · entities · relationships · meta-aware chunks — with no
silent partial success, and every transient failure retried or escalated, never dropped._

Companion to `kb_ingestion_2026-08-04.md` (the pipeline as-built) and `ingestion_v5.md`
(architecture — unchanged). Live baseline: `hm-core sha-1065370`.

## The one invariant

> **A job reaches `ready` only when the record proves it is finished.** Every segment that
> exists in Postgres is embedded in the vector store; memories are persisted (or the doc is
> explicitly `evidence_only`); entities + relationships have run; claim-structuring has run.
> Anything short of that keeps working or fails honestly — it never reports `ready`.

## Failures this campaign closes (all observed live this session)

| Obs | Failure | Phase |
|---|---|---|
| `[mneme/remote] kb-segment failed: This operation was aborted` | segment embed times out under load, **no reconciler backstop** → evidence silently missing | **P1** |
| `EXTRACTION SHORTFALL: kept 0 facts` (fact-bearing window) | 0 memories on sparse/OCR docs; single-pass, never escalated | **P2** |
| `deepseek finish=length → fallback` | truncation waste + latency on every small-JSON call | **P3** |
| `kb-relations proposed=0` | relationships inconsistent per doc | **P4** |
| job `ready` with partial embeds | silent partial success (no completion proof) | **P5** |
| `no start_page on ANY segment` | meta-chunking missing page cites on fast-pdf/vision tiers | **P6** |
| `/v1/hq/events/stream` reconnect → "Network connection lost" toast | pre-existing HQ SSE, not KB — global toast on normal reconnect | **P7 (FE)** |
| `Solvis_Branding_Skizze` marked failed w/ 6 segments | evidence-only mislabeled as failure | **DONE (10653708)** |

## Phases — each independently built, deployed, verified

### P1 — Segment-embed durability (biggest hole; no current backstop)
- Retry the `kb-segment` embed/write with bounded backoff on abort/timeout (today it aborts once and gives up).
- Extend `embed-reconciler.js` to a **second lane over `knowledge_segments`**: find segments in PG whose vectors are missing from the org's Qdrant collection and re-embed (same pattern as the memory lane). Runs on the 3-min tick + full sweep.
- Verify: force a segment-embed abort → reconciler heals within a tick; `segments_in_qdrant == segments_in_pg` for the test doc.

### P2 — Extraction escalation (0 facts → stronger model, NOT same-model re-sample)
- On a window with fact-bearing sentences that yields **0 facts** (or a severe shortfall), escalate **once** to a stronger model (`gpt-oss-120b`) — distinct from the rejected budget-shrinking re-sample of the same model.
- Keep evidence-only as the final honest floor if escalation still yields 0.
- Verify: re-ingest `Solvis_Branding_Skizze` → memories > 0 (was 0).

### P3 — Model/budget hygiene (kill the truncation waste)
- Size `max_tokens` for the most-verbose plausible model per feature (the `LLM_PROFILES` rule already exists — extend it); stop `deepseek finish=length` on `enterprise-extract` / `claim-structuring`, or route those to a model that doesn't truncate.
- Verify: zero `finish=length` on those features over a batch.

### P4 — Entity + relationship guarantee
- Ensure the relations pass runs and is retried on transient failure; when the direct proposer returns 0, the hybrid linker still covers. Confirm entities + typed edges land for every multi-fact doc.
- Verify: a multi-fact doc yields ≥1 entity and ≥1 relationship, or a logged honest reason.

### P5 — Completion contract (no silent partial `ready`)
- Before `complete()`, assert the finish invariant: document present · all segments embedded · memories persisted (or `evidence_only`) · claim-structuring done. If unmet, keep the job non-terminal (retry) rather than reporting `ready`.
- Return a structured `coverage` the FE already renders.
- Verify: a doc with a forced mid-embed abort does NOT reach `ready` until reconciled.

### P6 — Meta-aware chunking completeness
- Where the tier can supply page numbers (fast-pdf/vision), populate `start_page` so citations can name a page (heading_path is already good). Log honestly where a tier genuinely cannot.
- Verify: fast-pdf doc segments carry `start_page`.

### P7 — FE honesty + the connection toast
- Evidence-only success rendering — **DONE** (b760d6a).
- Stop the global "Network connection lost" toast firing on a **normal** HQ SSE (`/v1/hq/events/stream`) reconnect; only toast on a real sustained outage. Coordinate with the HQ-runtime session (PR #57 area).

## Execution order + ship discipline
P1 → P5 → P2 → P3 → P4 → P6 → P7. Each: branch off `origin/singulance-main`, build, deploy
core via `deploy-singulance-cloud.sh --services core` (FE via the §14 compose path), verify
in the running container + a real upload, record the release. Never mark a phase done on a
green build alone — prove it with a real ingest.

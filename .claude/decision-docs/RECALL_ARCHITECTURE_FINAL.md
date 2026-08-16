# HIVE-MIND Recall — Authoritative Architecture

Status: architecture contract as of 2026-08-16. Recall is deterministic retrieval plus optional external reranking; it contains no answer-generation LLM.

## Public API

`POST /api/recall` performs tenant-authorized grounded retrieval over canonical memories and source evidence.

Important inputs: query, mode, limit, entities, scope/project, source document, `valid_at`, `known_at`, and date range. Scope controls only narrow access; they never widen it.

The response preserves separate `memories` and `evidence` arrays for compatibility and also retains one authoritative mixed `ranked_candidates` order for chat and other consumers.

## Execution

```text
request + tenant access context
  -> normalize bounded recall plan
  -> resolve canonical entities and explicit/literal source metadata
  -> run authorized memory and evidence retrieval lanes
  -> normalize and deduplicate candidates
  -> one unified memory+evidence rerank
  -> filter superseded truth and retain mixed top 15
  -> serialize separate lanes plus mixed ranks, provenance and trace
```

### Memory lane

The memory lane searches current, authorized canonical memory rows through semantic vector retrieval and lexical/tag/entity/temporal signals. It hydrates authoritative Postgres/AMR records, applies tenant/project scope, excludes deleted and normally superseded rows, and may apply bounded pre-delivery signals such as memory type, event time and canonical entity alignment.

### Evidence lane

The evidence lane searches `knowledge_segments` through semantic vectors and true lexical retrieval. Evidence-only ingestion is first-class: zero promoted memories is valid and must still produce recallable evidence. Each candidate retains document, segment, page/offset, scope and source lineage.

### Source reads

A requested source is an authorization boundary, not a ranking hint. The server resolves a model-supplied or literal filename only against authorized document metadata, then restricts memory and evidence retrieval to that source. If resolution fails, recall fails closed as `source_not_found`; it never substitutes tenant-wide context.

### Temporal reads

Temporal intent is planner-supplied and compiled into `valid_at`, `known_at` or a bounded date range. Timeline mode may include superseded versions; normal recall defaults to current truth. Empty temporal coverage is distinct from transport failure.

## Delivery depth

Recall retrieves wide enough for ranking and retains one mixed top 15. `/api/recall` may return the requested bounded limit. Chat does not re-run recall to expand context:

- standard intent: ranks 1–5;
- detailed intent: ranks 1–10;
- comprehensive/source-overview intent: ranks 1–15.

Complete rank-one content is preferred when it fits. Lower-ranked rows use bounded semantic projections. A row is included whole within its budget; blind mid-row truncation is forbidden.

## Failure semantics

- timeout/unavailable: “could not look,” never “nothing exists”;
- authorized empty result: empty coverage;
- unresolved explicit source: source not found;
- reranker unavailable: deterministic lane-interleave degradation, reported in trace;
- vector drift: durable reconciliation/backfill, not silent placeholder vectors;
- remote Memory Box failure: explicit unavailable state, not central-store scope widening.

## Invariants

1. All reads are scoped by org, user and authorized project/team context.
2. Memories and evidence are both eligible for the same final top 15.
3. Exactly one external relevance rerank occurs per successful retrieval pass.
4. Evidence-only documents remain answerable.
5. Full source records remain canonical; delivery projection does not mutate storage.
6. No connector result, draft, approval or live provider response enters the recall cache.
7. Public recall is independent of chat model/provider routing and does not require Cloudflare AI Gateway.

## Trace contract

Expose retrieval backend, lane counts, dedup counts, scope/source resolution, latency per lane, candidate pool size, rerank model/status/time, ranking degradation, retained mixed ranks and total time. For chat, also report retrieval, rerank and synthesis pass counts separately.


# Latest Recall Architecture

Last updated: 2026-08-29

## Contract

All callers—V2 chat, MCP tools, direct API recall, temporal tools, managed storage, embedded storage, and BYOD Memory Box—must compile intent into one typed retrieval contract. Callers must not implement independent filtering or temporal semantics.

The public intent vocabulary should remain small:

- `relevant`
- `latest_mention`
- `latest_event`
- `as_of`
- `timeline`
- `diff`

The executor expands that intent into authorization, scope, entity/source/type/version filters, lane searches, deterministic ordering, deduplication, reranking, and hydration.

## Current execution path

```text
user query / tool input
  -> RetrievalSpec normalization
  -> tenant + user + project authorization
  -> canonical entity and source resolution
  -> parallel lanes
       memory lane: semantic + lexical + entity/graph candidates
       evidence lane: semantic + lexical + metadata/source candidates
  -> hard filter each lane
  -> deterministic ordering inside each lane
  -> merge without converting evidence into memory inventory
  -> deduplicate
  -> one rerank
  -> hydrate full selected rows
  -> return memories + evidence + trace to synthesis
```

## Filter order

Hard filters must run before ordering and reranking:

1. Tenant authorization.
2. User/project/scope authorization.
3. Storage layer (`memory` or `evidence`).
4. Entity, filename/source document, memory type, relation, and requested time boundary.
5. Version eligibility.
6. Ordering by the requested time axis.
7. Semantic relevance as primary rank or tie-breaker, depending on intent.

Stable order policies:

- ordinary recall: `relevance DESC, known_at DESC, id ASC`
- latest mention: `known_at DESC, relevance DESC, id ASC`
- latest event: `event_time DESC, known_at DESC, id ASC`
- historical snapshot: latest eligible version inside the requested boundary; never today’s unconditional `is_latest`

## Entity resolution and remote storage

Commit `5fa21505` changed canonical entity lookup to recognize both legacy `Entity` and newer `CanonicalEntity` records. For remote Memory Box tenants, canonical resolution must not create a central Memory relation that points to a memory owned only by the remote box.

The current remote projection design is:

1. Resolve or reuse the canonical entity centrally without linking an invalid central Memory FK.
2. Mirror the entity into the remote box.
3. Hydrate the remote memory.
4. Merge an acknowledged `entity:<slug>` tag onto the remote memory.
5. Create the remote `Mentions` edge.
6. Treat a failed acknowledgement as a projection failure, not success.

This is storage parity infrastructure; it does not compensate for a missing entity in the source extraction.

## Current verified behavior

- The scoped reconciliation applied 35 valid links across 15 memories with zero projection failures.
- Entity projections existed for SINGULANCE, GLOBIA, and P&P.
- Query-aware deterministic synthesis no longer uses unrelated recall rows to manufacture an answer.
- Focused ingestion/evidence/entity/relationship suites passed (29 tests in the implementation session).

## Unresolved failure

The Paolo canary still returned zero rows in both lanes. The immediate question is not “why did synthesis ignore evidence?” but “why did filtered recall produce no evidence?”

The next diagnostic must run read-only probes for the exact target tenant:

- list remote knowledge documents and locate the relevant filenames;
- lexical-search remote evidence for `Paolo` and normalized variants;
- inspect matching evidence metadata, document ID, title, page/section, scope, user/project ownership, and timestamps;
- inspect canonical Paolo metadata and source-document anchors;
- inspect whether the older central linked memory exists and whether its provenance permits remote migration.

Possible outcomes:

1. **Paolo exists in remote evidence.** The entity/source hard filter or metadata normalization is wrong. Fix the shared executor and test it across memory and evidence lanes.
2. **Paolo exists in source evidence but not promoted memories.** Canonical extraction lost an important named entity. Fix the intersection extractor/persister and reconcile without reparsing where possible.
3. **Paolo exists only in an orphan central memory.** Migrate the valid, authorized record to the Memory Box with provenance or remove the stale link; never silently cross-read central tenant data.
4. **Paolo is absent from all authorized source material.** The correct result is zero coverage. Do not fabricate a relationship or strategy.

## Required regression matrix

For each storage mode (managed, embedded, BYOD, hybrid), cover:

- entity exact match and alias match;
- entity plus filename;
- evidence-only document recall;
- memories-plus-evidence recall;
- memory-type filter;
- source filename/document ID filter;
- relationship filter;
- latest mention, latest event, range, as-of, timeline, and diff;
- zero-memory/nonzero-evidence response;
- zero-evidence/nonzero-memory response;
- deterministic tie ordering;
- unauthorized source exclusion;
- remote transport failure without central-data widening.

## Acceptance canary

Use the authorized target identifiers only through secrets or ephemeral environment variables; never commit credentials. The canary should issue:

1. Direct recall for `Who is Paolo?` with the entity filter.
2. Direct recall for the exact source filename.
3. Chat for `What should be our strategy with Paolo?`.
4. A broad document question that requires multiple evidence passages.

Pass criteria: nonzero correct rows when evidence exists, stable filtering/order, correct citations, no irrelevant fallback, and quiet post-turn logs.


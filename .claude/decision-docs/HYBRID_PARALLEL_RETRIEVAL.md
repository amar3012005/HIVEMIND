# Hybrid Parallel Retrieval — Wide Search, Unified Narrowing

This is the canonical ranking design shared by `/api/recall` and native recall inside `/api/chat`.

## Data flow

```text
canonical semantic query + structured controls
                 |
       +---------+---------+
       |                   |
  MEMORY SEARCH       EVIDENCE SEARCH
  semantic vector     semantic vector
  lexical/tags        lexical text
  entity/time         source/page filters
       |                   |
       +---------+---------+
                 |
      normalize + tenant-safe hydrate
                 |
      exact/logical dedup + lineage merge
                 |
      bounded pre-rank eligibility signals
                 |
     ONE mixed memory/evidence reranker
                 |
      supersession/correctness filtering
                 |
        authoritative mixed top 15
                 |
     memories[] + evidence[] + ranked_candidates[]
```

## Why the lanes stay separate until the final pool

Memory and evidence scores are not numerically comparable. Memory cosine, lexical evidence scores, rank fusion and graph signals use different scales. Sorting their raw scores together lets whichever lane has the larger numeric range dominate. Each lane therefore searches and orders candidates using its own valid signals, then hands candidates—not raw-score claims—to one shared cross-encoder.

## Wide retrieval

Wide retrieval protects small facts that are present only in source passages. The evidence lane may search substantially deeper than the delivered result; memory retrieval also retains more than the visible answer window. Wide is internal and bounded by deadlines, tenant scope and candidate limits.

Parallel means the independent memory and evidence I/O lanes overlap. It does not mean unbounded fan-out: remote Memory Box calls use bounded concurrency so one request cannot exhaust the tenant transport budget.

## Merge and deduplication

Before external reranking:

- normalize memory and evidence candidates into a common `{kind,title,content,identity,lineage}` shape;
- remove exact duplicate memory IDs;
- do not deliver both a promoted memory and the exact segment from which it was derived when that duplicates one fact;
- collapse logically identical evidence chunks using stable content hashes while retaining every authorized source/project provenance record;
- retain contradictory or competing values when they are genuinely distinct facts.

Deduplication happens only after authorization. Content identity must never be used to import provenance or access from another tenant/project.

## Boost and narrow

“Boost” means bounded candidate-generation signals applied before the final relevance authority: exact source, structured entity, memory type, temporal match, current working set and canonical claim fields. These signals help eligible facts enter the rerank pool; they do not overwrite the final cross-encoder score.

The cross-encoder sees memory and evidence together and ranks them against the same canonical query. It runs once. After ranking, only correctness filters such as supersession may remove a row. The first 15 surviving candidates become the authoritative retained order.

When the cross-encoder is unavailable, the fallback interleaves the already ordered lanes. It must not compare their incompatible raw scores, and the response trace must state that ranking degraded.

## Context delivery

The retained top 15 is stable for the turn. Chat chooses 5, 10 or 15 before synthesis according to semantic response depth. It does not retrieve or rerank again merely because the answer could be longer.

Evidence is delivered as one citation-bearing object per passage. Do not duplicate the same text in separate “memories” and “citation registry” prompt blocks. Rank one should be complete when it fits; otherwise projection preserves qualifiers, negation, units, dates and competing values.

## Required tests

1. Mixed memory/evidence corpus produces exactly one cross-encoder call.
2. Evidence-only content can occupy rank one and answer chat.
3. A relevant memory can outrank irrelevant evidence and vice versa.
4. Cross-project duplicate bytes consume one logical slot while preserving authorized provenance.
5. Tenant/project isolation holds before and after deduplication.
6. Timeline preserves chronological/version semantics.
7. Reranker timeout uses lane interleave and reports degradation.
8. Standard/detailed/comprehensive views are exact prefixes of the same top 15.
9. No truncation removes a requested qualifier from an otherwise selected passage.

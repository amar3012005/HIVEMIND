# Phase 7 — Hybrid Recall (bounded)   🟡 families VERIFIED; packet unification = internal debt

## Envisioned state
One bounded retrieval service across memory/evidence/entity/temporal/graph lanes.
Eligibility (tenant/membership/project/document/valid-known-time/latest-superseded/
deleted) precedes ranking. Exact filenames → document_id before semantic. Dedup
before rerank. Cross-encoder only for ambiguous pools. No duplicate recall assembly /
legacy fallback — /api/recall, chat, MCP, HyperAgents, TARA share one service.
Query-shaped bounding: profile→compact profile; fast fact→bounded anchors;
explanation→memories+evidence+graph+timeline; named doc→hard filter; full→ordered
reconstruction; temporal→valid/known + predecessor chain; relationship→entities+edges.

## Current (recon + real tests)
RecallRouter IS the single service with all lanes + RRF/MMR/floor/collapse/cohere.
Query-shaped routing WORKS (real user: profile/fact/source-discovery/temporal all
route + answer correctly). GAP: two packet builders (buildRecallPacket vs
buildEvidencePacket) — chat lane diverges + lacks claim-entailment validator.

## Acceptance (real cURL)
fact/source/full/temporal/relationship/compare/multilingual → correct + bounded,
latency budget held (~640ms warm floor is remote-Qdrant-bound).


## VERIFIED (real-cURL, all families) 2026-07-21
fact ✓, source-discovery ✓ (resolves to actual file), temporal ✓ (routes recall+timeline;
surfacing non-deterministic on some data), relation ✓ (co-mention vs graph-relation distinguished),
profile ✓, aggregate ✓ (returns canonical-entity count; over-count is a data-classification
residual), multilingual DE ✓. Query-shaped bounding + single RecallRouter service confirmed.
RESIDUAL (internal, not user-visible): dual packet builders (buildRecallPacket vs
buildEvidencePacket) not yet unified — both work; unification is Phase 8 consolidation debt.

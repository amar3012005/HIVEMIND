# Phase 6 — Canonical Entities & Fact Graph   🟡 PARTIAL

## Envisioned state
One org-scoped TYPED entity registry (person/organization/product/project/document/
location/system/technology/standard/concept) used by every source. Exact verified
ids + approved aliases auto-link; fuzzy → review, never auto-merge. One validator owns
Updates(demote+edge 1 txn)/Extends(both current)/Contradicts(preserve both)/
Derives(async, ≥0.75)/PartOf/Mentions. Use claimKey before vector similarity;
similarity proposes candidates, never authorizes an edge.

## Done (SHIPPED 72e73e171, live)
Code-enforced ENTITY_TAXONOMY + normalizeEntityKind() at the persist chokepoint
(synonyms→taxonomy; 'entity'/unknown pass through, migration-safe → no fragmentation).

## Not done
Typed entities are still emitted as generic 'entity' by the extractor (guard is inert
until Phase 3 feeds typed kinds). Relationship rules already centralized in
relationship-semantics (enforce mode) + Updates transactional (pre-existing); the
Derives ≥0.75 hard gate + full operator centralization not verified/finished.

## Acceptance (real cURL)
Ingest KB+email+meeting+chat about the same product → one canonical entity, valid
cross-source links, no false destructive edges, tenant isolation intact.


## Increment (entity dedup at create — user ask)
Before minting a canonical entity, reuse any existing one with the SAME
normalizedName in the org REGARDLESS of entityKind (oldest wins). _bestMatch
scopes by kind, so the same real entity classified under different kinds by
different paths (SolvisMax=product vs solvismax=company) created case/kind
variants; fix is
language-neutral (unicode-aware lowercase normalizedName) + immediately-consistent
(Postgres, no race). PREVENTS new variants; a one-time merge of the 2 existing
dupes is a separate destructive step (deferred).

## Correction (tenant isolation)
The SolvisMax/solvismax + VIESSMANN/viessmann pairs are in DIFFERENT ORGS
(1380251c vs 807ebb88) — correctly tenant-isolated, NOT duplicates. Merging them
would violate isolation, so NO merge done. The dedup fix scopes by organizationId
(intra-org only). Zero real intra-org dupes. Verified: 3 case variants of one
name in one org → 1 canonical entity.

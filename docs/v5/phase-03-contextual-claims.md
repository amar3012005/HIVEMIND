# Phase 3 — Contextual Claim Extraction   🟡 corroboration-dedup WORKING on entity-anchored claims ← THE UNLOCK

## Envisioned state (north-star Memory-Quality)
Extractor emits STRUCTURED CanonicalClaim: {title, memoryType, content, subject,
predicate, qualifiers, entities[], importance, confidence, eventTime, sourceQuote,
supportSegmentIds}. Fewer, richer contextual claim bundles — subject+predicate+scope+
conditions+numbers+rationale+exact support — NOT sentence fragments or paraphrase dups.
Adaptive per-source counts (image=1, atomic=1, short=0, meeting=decisions/commitments/
owners/deadlines, product doc=specs/compat/config/limits, report=bounded bundles).
Reject headings/signatures/boilerplate/OCR-junk/generic/unsupported-inference.

## Why this is the unlock (root-cause from real-user testing 2026-07-21)
Paraphrase-dedup + authorized predecessor demotion + correct lifecycle
(dup/Extends/Updates/Contradicts) ALL depend on structured claim data. The lifecycle
machinery + superseding validator ALREADY EXIST (graph-engine applyUpdate + enforce-mode
validator) but are STARVED of structured subject/predicate/qualifiers, so they
conservatively refuse destructive edges. Feed them structured claims → the rest unlocks.

## Acceptance (real cURL, real user)
Upload a product PDF → fewer, richer memories each with subject/predicate + exact
sourceQuote + supportSegmentIds; no OCR junk; detail not promoted still recallable
via evidence. Save same-value reworded claim → attaches evidence, NO new memory.


## Increment shipped (corroboration guard)
Pre-create: when the smart-ingest LLM labels a same-topic claim UPDATE but the
structured claim signature (validateSupersedingEdge→assessClaimRelation) proves
same-subject + values AGREE, downgrade to operation="corroborated" (skip the
duplicate; keep the existing memory). Reuses claim-signature.js (no new extractor).
Flag V5_CORROBORATION_DEDUP (default on). Conservative: only a proven
values-agree verdict skips; changed value still creates Updates. VERIFIED no-harm.

**HONEST STATUS (real-cURL): the guard is INERT on the mode=atomic /api/ingest/source
path** — that dispatch bypasses the smart-ingest dedup block where the guard lives
(gated by smartIngest!==false), so a reworded-equivalent atomic save still created a
2nd memory in testing. The guard IS active on KB fact-distillation / smart-ingest
paths. To close atomic paraphrase-dedup: enable a semantic dedup pass on the atomic
dispatch (or run the structured claim signature pre-create there). DEFERRED.
FOLLOW-UP: evidence-attach on skip; full subject/predicate/qualifier extraction for
KB claim bundles; enable on atomic path.


## VERIFIED WORKING (fa9dcecb3, live, real-cURL, real user)
Entity-anchored atomic claims now dedup paraphrase-equivalents: A "40 liters per
minute" → B reworded-equal → op=corroborated (NO new memory); C "55 L/min" changed
→ new memory. DB = 2 rows, not 3. No data loss on the changed value. Postgres tag
query (immediately consistent, scope-tier-robust), language-neutral (value slots +
entity slug). Root fixes that got here: (1) spelled-out+SI unit parsing; (2) move
check from Qdrant-lagged smart-ingest to Postgres pre-check; (3) candidate lookup
by entity tag not scope-filtered listLatestMemories. Still needs subject extraction
for BARE atomic content with no entity anchor.


## CORRECTION — corroboration guard DISABLED by default (data-loss risk)
Real-cURL found a data-loss path: a CHANGED value in an UNRECOGNIZED unit ("48
ports" → "96 ports"; "ports" not in the unit table) cannot be told from equal by
value slots → falls to token-Jaccard → reads as "no change" → drops the changed
claim. The guard is only safe when values use recognized units — too brittle/
vocabulary-dependent to be safe for arbitrary tenant/language content. Flag
V5_CORROBORATION_DEDUP now defaults OFF (opt-in only). Exact-duplicate skip
(content-hash, already safe) remains. Robust reworded/semantic dedup requires the
proper multilingual LLM claim extractor (subject/predicate/qualifiers) — deferred.

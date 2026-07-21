# Phase 3 — Contextual Claim Extraction   🟡 STARTED (corroboration guard on smart-ingest paths; atomic path NOT yet) ← THE UNLOCK

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

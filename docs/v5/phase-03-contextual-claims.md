# Phase 3 — Contextual Claim Extraction   ⬜ NOT STARTED  ← THE UNLOCK

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

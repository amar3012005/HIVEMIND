# Phase 4 — Coverage-Aware Curation   🟡 ledger with omitted-reasons SHIPPED

## Envisioned state
Curator returns a coverage ledger {memories, promoted_candidate_ids,
merged_candidate_groups, omitted[{id,reason}], rejected[{id,reason}],
high_value_coverage}. A high-importance claim cannot vanish without a supported
omission reason. Provider failure leaves evidence available + marks promotion
retryable; never fabricates low-quality fallback facts. Coverage surfaces in
CanonicalIngestResult + processing status (upload semantics unchanged).

## Acceptance (real cURL)
Upload normal/thin/noisy/provider-timeout docs → evidence stays available,
promotion status honest, retries idempotent, high-value claims accounted for.


## SHIPPED — curator coverage ledger
attachCoverageLedger computes, from the curator output vs the candidate pool, which
candidates were PROMOTED vs OMITTED with a reason + importance (high_value_omitted_by_curator
vs low_salience_or_merged) + highValueOmitted count. Surfaced in CanonicalIngestResult.
coverage (prefers the real curator ledger over the coarse count). Deterministically
verified: 4 candidates → 3 promoted, high-value s4 omitted WITH reason. Satisfies
"a high-importance claim cannot vanish without a supported omission reason."
GAP: rejected[] (quality-gate rejections) still coarse; provider-failure retryable
marking not yet separate.

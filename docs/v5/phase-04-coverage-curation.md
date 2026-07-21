# Phase 4 — Coverage-Aware Curation   ⬜ NOT STARTED

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

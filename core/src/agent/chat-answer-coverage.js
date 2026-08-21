// Normalization for the synthesis model's semantic answer-accounting output.
// The model, not a keyword list, decomposes a request into its independent
// details. This module only makes that decision safe to expose and ensures an
// explicitly incomplete answer cannot be labelled sufficient.

export function normalizeAnswerCoverage(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object' && typeof item.request === 'string' && item.request.trim())
    .slice(0, 12)
    .map((item) => ({
      request: item.request.trim().slice(0, 500),
      status: item.status === 'supported' ? 'supported' : 'unsupported',
      citation_ids: Array.isArray(item.citation_ids)
        ? item.citation_ids.filter((id) => typeof id === 'string' && id.trim()).slice(0, 8)
        : [],
    }));
}

export function deriveAnswerContextStatus(payload = {}) {
  const reported = payload?.context_status;
  if (reported === 'query_mismatch') return reported;
  if (reported === 'relevant_but_incomplete') return reported;
  const coverage = normalizeAnswerCoverage(payload?.coverage);
  const hasSupportedDetail = coverage.some((item) => item.status === 'supported');
  const hasUnsupportedDetail = coverage.some((item) => item.status === 'unsupported');
  const hasGap = Array.isArray(payload?.gaps) && payload.gaps.some((gap) => typeof gap === 'string' && gap.trim());
  // When the model decomposed the request but found support for none of its
  // requested details, the packet is off-objective, not merely incomplete.
  // This keeps an unrelated but citation-valid fact from becoming the answer.
  if (coverage.length > 0 && !hasSupportedDetail && hasUnsupportedDetail) return 'query_mismatch';
  return (hasUnsupportedDetail || hasGap) ? 'relevant_but_incomplete' : 'sufficient';
}

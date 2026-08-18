export function lexicalQueryTokens(value) {
  return [...new Set((String(value || '').normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) || [])
    .map((token) => token.toLocaleLowerCase())
    // Keep numeric identifiers and single-codepoint non-Latin terms (useful in
    // CJK); ordinary Latin one-letter conversational noise is discarded.
    .filter((token) => /\p{N}/u.test(token)
      || Array.from(token).length >= 2
      || /[^\x00-\x7F]/u.test(token)))];
}

export function buildWideTsQuery(value) {
  // This is a WIDE candidate lane. OR semantics avoid letting conversational
  // filler veto an exact fact; the existing fusion/rerank stage owns precision.
  return lexicalQueryTokens(value).map((token) => `${token}:*`).join(' | ');
}

/**
 * Expensive fuzzy forms are a sparse-recall fallback, not part of the primary
 * FTS predicate.  Joining every adjacent pair in a natural sentence creates
 * meaningless forms (conversation filler included) and forces PostgreSQL to
 * run word_similarity over every candidate's full content.
 *
 * A joined form is useful for the actual split-token case ("Solvis Tim" vs
 * "SolvisTim").  Restrict that form to a focused two-token query.  Individual
 * long tokens remain available for typo recovery when indexed FTS is sparse.
 * This is language-independent: no stop-word or product-name list is involved.
 */
export function buildTrigramFallbackForms(value, maxForms = 4) {
  const tokens = lexicalQueryTokens(value);
  const forms = new Set();
  if (tokens.length === 2) {
    const joined = tokens.join('');
    if (joined.length >= 6) forms.add(joined);
  }
  for (const token of tokens) {
    if (token.length >= 6) forms.add(token);
    if (forms.size >= maxForms) break;
  }
  return [...forms].slice(0, Math.max(0, maxForms));
}

export function shouldRunTrigramFallback({ enabled, forms = [], ftsCount = 0, requested = 0, threshold = 12 }) {
  if (!enabled || forms.length === 0) return false;
  const boundedThreshold = Math.min(
    Math.max(0, Number(requested) || 0),
    Math.max(0, Number(threshold) || 0),
  );
  return Number(ftsCount) < boundedThreshold;
}

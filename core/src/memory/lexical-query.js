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

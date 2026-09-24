// Stable, local lexical sparse projection. Identical terms produce identical
// dimensions at index and query time; Qdrant supplies collection-wide IDF.
const MAX_TERMS = 256;

function hash(term) {
  let value = 2166136261;
  for (const char of term) {
    value ^= char.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

export function recallSparseVector(text) {
  const counts = new Map();
  for (const match of String(text || '').toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)) {
    const term = match[0];
    if (term.length < 2 || term.length > 80) continue;
    const dimension = hash(term);
    if (!counts.has(dimension) && counts.size >= MAX_TERMS) continue;
    counts.set(dimension, (counts.get(dimension) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort(([left], [right]) => left - right);
  return { indices: sorted.map(([index]) => index), values: sorted.map(([, count]) => 1 + Math.log(count)) };
}

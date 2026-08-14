/**
 * Decide whether the initial memory-only retrieval may call the external
 * cross-encoder.
 *
 * Recall has one relevance authority at its delivery boundary: the unified
 * memory + evidence rerank (or chronological ordering for a timeline). Running
 * a memory-only cross-encoder before that boundary adds network latency and its
 * order is immediately replaced. Memory-only callers, which have no later
 * authority, retain the existing env/default behaviour through `null`.
 */
export function initialMemoryCrossRerank({
  laterAuthoritativeOrdering = true,
  requested = null,
} = {}) {
  if (laterAuthoritativeOrdering) return false;
  return requested == null ? null : requested === true;
}


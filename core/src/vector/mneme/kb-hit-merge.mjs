/**
 * Evidence-recall candidate merge + emit. Pure, dependency-free, and deliberately in its own
 * module so it can be unit-tested WITHOUT the native `.amr` binding.
 *
 * WHY THIS IS NOT INLINE IN THE HANDLER
 *   `/v1/kb-recall` fans out over two lanes (Qdrant, then the shard's evidence layer) and then
 *   emits rows the Postgres access join allowed. The first version of that merge collected ids
 *   into an array and then rebuilt the result by mapping over LANE A's response variable to
 *   recover scores — but that variable is block-scoped to the lane-A `try`, so the return threw
 *   `ReferenceError: j is not defined` on every recall that actually found something. It was a
 *   guaranteed break, invisible to `node --check` (the syntax is valid) and to the repo's lint
 *   script (a no-op that globs `.ts` in a `.js` codebase), and it sat latent purely because no
 *   `.amr` org happened to run a KB recall.
 *
 *   The structural lesson, not just the fix: emitting must read from the MERGED candidate set,
 *   never from one lane's raw response. Keeping that step here — pure and covered — means it
 *   cannot silently regress inside a closure again.
 *
 * ACCESS CONTROL IS THE CALLER'S JOB, AND MUST STAY THAT WAY. `allowed` is the set of ids the
 * `knowledge_documents` join with `appendDocumentAccess` returned. Anything absent from it is
 * dropped here regardless of which lane produced it, so a shard candidate the caller may not see
 * is discarded exactly as a Qdrant one is.
 *
 * @module src/vector/mneme/kb-hit-merge
 */

/**
 * Add a lane's candidates to the merged set. First lane to produce an id owns its score, so
 * lane order is the ranking prior; later lanes only top the pool up.
 *
 * @param {Map<string, number>} hits merged candidates, insertion-ordered (mutated)
 * @param {Iterable<{id: string, score?: number}>} candidates this lane's hits, best-first
 * @returns {Map<string, number>} the same map, for chaining
 */
export function addLane(hits, candidates) {
  for (const c of candidates || []) {
    if (!c || !c.id) continue;
    if (!hits.has(c.id)) hits.set(c.id, typeof c.score === 'number' ? c.score : 0);
  }
  return hits;
}

/**
 * Emit hydrated rows in candidate order, keeping only ids the access join allowed.
 *
 * @param {Map<string, number>} hits merged candidates, insertion-ordered
 * @param {Map<string, object>} allowed segment_id -> hydrated row, post-access-check
 * @returns {object[]} rows with their originating lane's score attached
 */
export function emitKbResults(hits, allowed) {
  const out = [];
  for (const [id, score] of hits) {
    const row = allowed.get(id);
    if (row) out.push({ ...row, score });
  }
  return out;
}

/**
 * Shard layer ids and the recallability rule. Pure and dependency-free ON PURPOSE: `amr-store.mjs`
 * loads the native binding at module scope, so anything defined there cannot be unit-tested on a
 * machine without the binding. That is the same trap that left the evidence-recall merge step
 * uncovered until it shipped a crash — a rule that decides what a user is allowed to see is not
 * something to leave untestable.
 *
 * `insert_layered` takes a u8, so the layer set is open; 0/1/2 is a convention, not a format limit.
 *
 *   0 memory · 1 evidence · 2 cognitive
 *       Content layers. The memory pipeline deliberately recalls across all of them
 *       (`recallLayer(..., -1)`) — cross-layer memory+evidence recall is a feature.
 *
 *   3 document
 *       NOT content. Carries a document's owner, scope-key grants and title so the slot can
 *       answer "who may see this segment" without the `knowledge_documents` join. It is the
 *       shard-side half of that join and the input to `doc-access.mjs`.
 *
 * @module src/vector/mneme/layers
 */

export const DOCUMENT_LAYER = 'document';

const LAYER_ID = { memory: 0, evidence: 1, cognitive: 2, [DOCUMENT_LAYER]: 3 };

/** Slot-header layer id for a record's layer name. Unknown/absent → memory (0). */
export function layerIdOf(layer) {
  return LAYER_ID[layer] ?? 0;
}

/**
 * True when a record must be withheld from a CONTENT search.
 *
 * Document records have no meaningful vector (a zero placeholder), so in principle they rank
 * last — but "ranks last" is not a guarantee, and an over-fetched pool on a small corpus returns
 * them anyway. If one reached a recall pipeline it would be rendered to the user as though it
 * were a memory.
 *
 * Opt-IN by design: only a caller naming the layer explicitly gets these back, so a caller that
 * forgets receives nothing rather than gating metadata dressed as content.
 *
 * @param {object|null} rec
 * @param {object} [filter]
 * @returns {boolean}
 */
export function isNonRecallable(rec, filter = {}) {
  return rec?.layer === DOCUMENT_LAYER && filter?.layer !== DOCUMENT_LAYER;
}

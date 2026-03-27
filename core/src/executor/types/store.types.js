/**
 * Trail Executor — Store Type Contracts
 * HIVE-MIND Cognitive Runtime
 *
 * Types for memory-promotion candidates and the graph-store interface.
 */

/**
 * A memory-promotion candidate: an observation deemed worthy of
 * long-term storage in the HIVE-MIND knowledge graph.
 *
 * @typedef {Object} PromotionCandidate
 * @property {import('./agent.types.js').PromotionCandidateId} id
 * @property {import('./agent.types.js').TrailId} trailId - Originating trail
 * @property {import('./agent.types.js').GoalId} goalId
 * @property {import('./agent.types.js').NamespaceId} namespaceId
 * @property {string} content - Textual content to promote
 * @property {'fact' | 'insight' | 'procedure' | 'episode'} kind - Memory classification
 * @property {number} confidence - Promotion confidence score (0-1)
 * @property {string[]} tags - Tags for graph indexing
 * @property {Record<string, *>} [metadata] - Additional metadata
 * @property {number} createdAt - Unix epoch ms
 */

/**
 * GraphStore interface — consumed via dependency injection.
 * Implementations back onto the HIVE-MIND memory engine.
 *
 * @interface GraphStore
 *
 * @method promoteCandidate
 * @param {PromotionCandidate} candidate
 * @returns {Promise<{ memoryId: string, stored: boolean }>}
 *
 * @method recallForGoal
 * @param {import('./agent.types.js').GoalId} goalId
 * @param {import('./agent.types.js').NamespaceId} namespaceId
 * @param {{ maxResults?: number, minConfidence?: number }} [options]
 * @returns {Promise<import('./agent.types.js').Observation[]>}
 *
 * @method getRelatedMemories
 * @param {string} content
 * @param {import('./agent.types.js').NamespaceId} namespaceId
 * @param {{ maxResults?: number }} [options]
 * @returns {Promise<import('./agent.types.js').Observation[]>}
 */

export const STORE_TYPES = Symbol.for('hivemind.executor.store.types');

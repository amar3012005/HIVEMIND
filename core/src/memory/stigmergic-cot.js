/**
 * Stigmergic Chain-of-Thought — Agent Swarm Memory
 *
 * Turns the memory graph into a stigmergic medium where agents coordinate
 * through environmental modification (pheromone trails) rather than direct
 * messaging. O(n) communication vs O(n^2).
 *
 * Architecture (per NotebookLM research):
 *   - Thoughts as memory nodes with ['cot', 'task:{id}', 'agent:{id}'] tags
 *   - Extends relationships for chain linking (sequential reasoning)
 *   - Affordances (decision type, 'affordance' tag) = successful paths
 *   - Disturbances (lesson type, 'disturbance' tag) = failed paths to avoid
 *   - TTL-based pruning (traces evaporate like pheromones)
 *   - Agents sense environment before acting, not ask each other
 *
 * @module memory/stigmergic-cot
 */

import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// StigmergicCoT
// ---------------------------------------------------------------------------

/**
 * StigmergicCoT — shared reasoning environment for agent swarms.
 */
export class StigmergicCoT {
  /**
   * @param {object} opts
   * @param {object} opts.store — PrismaGraphStore or InMemoryGraphStore
   * @param {number} [opts.traceTTLMinutes=30] — TTL for traces before evaporation
   */
  constructor({ store, traceTTLMinutes = 30 } = {}) {
    if (!store) throw new Error('StigmergicCoT requires a store');
    this.store = store;
    this.traceTTLMinutes = traceTTLMinutes;
  }

  /**
   * Record a thought in the shared knowledge graph.
   * If parentThoughtId is provided, creates an Extends relationship.
   *
   * @param {string} agentId
   * @param {object} opts
   * @param {string} opts.userId
   * @param {string} opts.orgId
   * @param {string} opts.content — the reasoning step
   * @param {string} [opts.taskId] — task context
   * @param {string} [opts.parentThoughtId] — previous thought in chain
   * @param {string} [opts.reasoning_type='step'] — step|conclusion|hypothesis|observation
   * @param {number} [opts.confidence=1.0]
   * @param {object} [opts.metadata={}]
   * @returns {Promise<{ thoughtId: string, chainDepth: number }>}
   */
  async recordThought(agentId, { userId, orgId, content, taskId, parentThoughtId, reasoning_type = 'step', confidence = 1.0, metadata = {} } = {}) {
    const tags = ['cot', `agent:${agentId}`];
    if (taskId) tags.push(`task:${taskId}`);
    tags.push(`reasoning:${reasoning_type}`);

    const expiresAt = new Date(Date.now() + this.traceTTLMinutes * 60000).toISOString();

    const thought = await this.store.createMemory({
      id: uuidv4(),
      user_id: userId,
      org_id: orgId,
      content,
      memory_type: reasoning_type === 'conclusion' ? 'decision' : 'event',
      tags,
      is_latest: true,
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: { ...metadata, is_trace: true, expires_at: expiresAt, agent_id: agentId, reasoning_type, confidence },
      source_metadata: { source_type: 'agent', source_platform: 'stigmergic-cot', source_id: agentId }
    });

    let chainDepth = 1;

    // Link to parent via Extends
    if (parentThoughtId) {
      await this.store.createRelationship({
        id: uuidv4(),
        from_id: thought.id,
        to_id: parentThoughtId,
        type: 'Extends',
        confidence,
        created_at: new Date().toISOString(),
        metadata: { chain_type: 'cot' }
      });

      // Calculate chain depth by traversing
      chainDepth = await this._getChainDepth(parentThoughtId) + 1;
    }

    return { thoughtId: thought.id, chainDepth };
  }

  /**
   * Deposit a trace (affordance or disturbance).
   *
   * - Affordance: records a successful action path (other agents should follow)
   * - Disturbance: records a failed action path (other agents should avoid)
   *
   * @param {string} agentId
   * @param {object} opts
   * @param {string} opts.userId
   * @param {string} opts.orgId
   * @param {string} opts.action — what was attempted
   * @param {string} opts.result — outcome description
   * @param {boolean} opts.success — true=affordance, false=disturbance
   * @param {string} [opts.taskId]
   * @param {string} [opts.targetMemoryId] — memory the action relates to
   * @param {object} [opts.metadata={}]
   * @returns {Promise<{ traceId: string, traceType: 'affordance'|'disturbance' }>}
   */
  async depositTrace(agentId, { userId, orgId, action, result, success, taskId, targetMemoryId, metadata = {} } = {}) {
    const traceType = success ? 'affordance' : 'disturbance';
    const memoryType = success ? 'decision' : 'lesson';
    const content = success
      ? `Action Succeeded: ${action}. Result: ${result}.`
      : `Action Failed: ${action}. Result: ${result}. Do not repeat.`;

    const tags = ['cot', 'trace', traceType, `agent:${agentId}`];
    if (taskId) tags.push(`task:${taskId}`);

    const expiresAt = new Date(Date.now() + this.traceTTLMinutes * 60000).toISOString();

    const trace = await this.store.createMemory({
      id: uuidv4(),
      user_id: userId,
      org_id: orgId,
      content,
      memory_type: memoryType,
      tags,
      is_latest: true,
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: { ...metadata, is_trace: true, trace_type: traceType, expires_at: expiresAt, agent_id: agentId, action },
      source_metadata: { source_type: 'agent', source_platform: 'stigmergic-cot', source_id: agentId }
    });

    // Link to target memory if provided
    if (targetMemoryId) {
      await this.store.createRelationship({
        id: uuidv4(),
        from_id: trace.id,
        to_id: targetMemoryId,
        type: 'Derives',
        confidence: success ? 1.0 : 0.5,
        created_at: new Date().toISOString(),
        metadata: { trace_type: traceType }
      });
    }

    return { traceId: trace.id, traceType };
  }

  /**
   * Follow traces — sense the environment before acting.
   * Returns the current state of reasoning for a task.
   *
   * @param {string} userId
   * @param {string} orgId
   * @param {object} [opts]
   * @param {string} [opts.taskId]
   * @param {string} [opts.action] — filter by specific action type
   * @param {number} [opts.limit=20]
   * @returns {Promise<{ currentHead: object|null, affordances: Array, disturbances: Array, fullChain: Array }>}
   */
  async followTraces(userId, orgId, { taskId, action, limit = 20 } = {}) {
    const tags = ['cot'];
    if (taskId) tags.push(`task:${taskId}`);

    const results = await this.store.searchMemories({
      query: action || '',
      user_id: userId,
      org_id: orgId,
      tags,
      n_results: limit
    });

    // Filter out expired traces
    const now = Date.now();
    const active = results.filter(m => {
      const expiresAt = m.metadata?.expires_at;
      return !expiresAt || new Date(expiresAt).getTime() > now;
    });

    // Separate by type
    const affordances = active.filter(m => (m.tags || []).includes('affordance'));
    const disturbances = active.filter(m => (m.tags || []).includes('disturbance'));
    const thoughts = active.filter(m => !(m.tags || []).includes('affordance') && !(m.tags || []).includes('disturbance'));

    // Sort by recency
    const sorted = [...active].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return {
      currentHead: sorted[0] || null,
      affordances,
      disturbances,
      fullChain: thoughts.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
      totalTraces: active.length
    };
  }

  /**
   * Get the full thought chain starting from a thought ID.
   *
   * @param {string} thoughtId
   * @param {object} [opts]
   * @param {number} [opts.maxDepth=10]
   * @returns {Promise<Array>}
   */
  async getThoughtChain(thoughtId, { maxDepth = 10 } = {}) {
    const chain = [];
    let currentId = thoughtId;

    for (let depth = 0; depth < maxDepth; depth++) {
      const memory = await this.store.getMemory(currentId);
      if (!memory) break;

      chain.unshift({
        id: memory.id,
        content: memory.content,
        memory_type: memory.memory_type,
        reasoning_type: memory.metadata?.reasoning_type || 'step',
        agent_id: memory.metadata?.agent_id,
        created_at: memory.created_at
      });

      // Find parent via Extends relationship
      const relationships = await this.store.getRelatedMemories(currentId, { maxDepth: 1 });
      const parentEdge = relationships.find(r => r.from_id === currentId && r.type === 'Extends');
      if (!parentEdge) break;
      currentId = parentEdge.to_id;
    }

    return chain;
  }

  /**
   * Prune stale traces (pheromone evaporation).
   *
   * @param {string} userId
   * @param {string} orgId
   * @param {object} [opts]
   * @param {number} [opts.maxAgeDays] — override TTL-based pruning with days
   * @returns {Promise<{ pruned: number }>}
   */
  async pruneStaleTraces(userId, orgId, { maxAgeDays } = {}) {
    const results = await this.store.searchMemories({
      query: '',
      user_id: userId,
      org_id: orgId,
      tags: ['cot'],
      n_results: 500
    });

    const now = Date.now();
    let pruned = 0;

    for (const trace of results) {
      const expiresAt = trace.metadata?.expires_at;
      const createdAt = trace.created_at;

      let shouldPrune = false;

      if (expiresAt && new Date(expiresAt).getTime() < now) {
        shouldPrune = true; // TTL expired
      } else if (maxAgeDays && createdAt) {
        const ageDays = (now - new Date(createdAt).getTime()) / 86400000;
        if (ageDays > maxAgeDays) shouldPrune = true;
      }

      if (shouldPrune) {
        await this.store.updateMemory(trace.id, { is_latest: false, updated_at: new Date().toISOString() });
        pruned++;
      }
    }

    return { pruned };
  }

  /**
   * Get chain depth by traversing Extends relationships.
   * @param {string} thoughtId
   * @returns {Promise<number>}
   */
  async _getChainDepth(thoughtId) {
    let depth = 0;
    let currentId = thoughtId;

    while (depth < 50) {
      const relationships = await this.store.getRelatedMemories(currentId, { maxDepth: 1 });
      const parentEdge = relationships.find(r => r.from_id === currentId && r.type === 'Extends');
      if (!parentEdge) break;
      currentId = parentEdge.to_id;
      depth++;
    }

    return depth + 1; // +1 for the initial thought
  }
}

// ---------------------------------------------------------------------------
// ReasoningChainBuilder — convenience helper
// ---------------------------------------------------------------------------

/**
 * ReasoningChainBuilder — fluent API for constructing reasoning chains.
 */
export class ReasoningChainBuilder {
  /**
   * @param {StigmergicCoT} cot
   */
  constructor(cot) {
    this.cot = cot;
    this._chain = [];
    this._agentId = null;
    this._taskId = null;
    this._userId = null;
    this._orgId = null;
    this._headId = null;
  }

  /**
   * Start a new reasoning chain.
   */
  start(agentId, { userId, orgId, taskId, goal }) {
    this._agentId = agentId;
    this._userId = userId;
    this._orgId = orgId;
    this._taskId = taskId;
    this._goal = goal;
    return this;
  }

  /**
   * Add a reasoning step.
   */
  async addStep(content, reasoning_type = 'step') {
    const result = await this.cot.recordThought(this._agentId, {
      userId: this._userId,
      orgId: this._orgId,
      content,
      taskId: this._taskId,
      parentThoughtId: this._headId,
      reasoning_type
    });

    this._headId = result.thoughtId;
    this._chain.push({ id: result.thoughtId, content, reasoning_type, depth: result.chainDepth });
    return this;
  }

  /**
   * Conclude the chain.
   */
  async conclude(conclusion) {
    await this.addStep(conclusion, 'conclusion');
    return this;
  }

  /**
   * Get the built chain.
   */
  getChain() {
    return {
      agentId: this._agentId,
      taskId: this._taskId,
      goal: this._goal,
      headId: this._headId,
      steps: this._chain
    };
  }
}

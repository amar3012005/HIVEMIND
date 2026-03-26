/**
 * Operator Layer — Cognitive Rhythm
 *
 * Higher-order layer that dictates relevance, prioritization, context
 * re-assembly, and symbolic coherence. Transforms the knowledge graph
 * from passive storage into a structural skeleton the model "grows around."
 *
 * Architecture (per NotebookLM research):
 *   - Intent-based routing: determines WHY info is needed before retrieval
 *   - Cognitive frame assembly: Static Profile → Dynamic → Heuristics → Connectors
 *   - Dynamic weight adjustment: modifies scorer weights based on query intent
 *   - Symbolic coherence: prevents contradictions when new memories arrive
 *
 * @module memory/operator-layer
 */

import { computeTokenSimilarity } from './conflict-detector.js';

// ---------------------------------------------------------------------------
// Intent Detection
// ---------------------------------------------------------------------------

const TEMPORAL_PATTERNS = [
  /\b(when|yesterday|today|last\s+(?:week|month|year)|ago|before|after|since|during|timeline|history|past|evolution)\b/i,
  /\b\d{4}[-/]\d{2}[-/]\d{2}\b/,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i
];

const ACTION_PATTERNS = [
  /\b(build|create|implement|fix|deploy|write|code|develop|setup|configure|install|run|execute|make|help\s+me)\b/i
];

const FACTUAL_PATTERNS = [
  /\b(what\s+is|define|explain|describe|tell\s+me\s+about|how\s+does|who\s+is|where\s+is)\b/i
];

const EMOTIONAL_PATTERNS = [
  /\b(feel|stuck|frustrated|confused|worried|happy|excited|overwhelmed|lost|struggling)\b/i
];

const EXPLORATORY_PATTERNS = [
  /\b(analyze|why|how|relationship|pattern|insight|compare|explore|investigate|understand)\b/i
];

/**
 * Detect the intent behind a query to route retrieval and adjust weights.
 *
 * @param {string} query
 * @returns {{ type: 'temporal'|'factual'|'action'|'emotional'|'exploratory', confidence: number, entities: string[], timeReferences: string[] }}
 */
export function detectQueryIntent(query) {
  if (!query || typeof query !== 'string') {
    return { type: 'factual', confidence: 0.3, entities: [], timeReferences: [] };
  }

  const q = query.trim();

  // Extract entities: quoted terms + capitalized multi-word phrases
  const quoted = [...q.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const capitalized = [...q.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g)]
    .map(m => m[1])
    .filter(e => e.length > 2);
  const entities = [...new Set([...quoted, ...capitalized])];

  // Extract time references
  const timeReferences = [];
  for (const pattern of TEMPORAL_PATTERNS) {
    const matches = [...q.matchAll(new RegExp(pattern.source, 'gi'))];
    for (const m of matches) timeReferences.push(m[0]);
  }

  // Score each intent type
  const scores = {
    temporal: TEMPORAL_PATTERNS.reduce((s, p) => s + (p.test(q) ? 1 : 0), 0),
    action: ACTION_PATTERNS.reduce((s, p) => s + (p.test(q) ? 1 : 0), 0),
    factual: FACTUAL_PATTERNS.reduce((s, p) => s + (p.test(q) ? 1 : 0), 0),
    emotional: EMOTIONAL_PATTERNS.reduce((s, p) => s + (p.test(q) ? 1 : 0), 0),
    exploratory: EXPLORATORY_PATTERNS.reduce((s, p) => s + (p.test(q) ? 1 : 0), 0)
  };

  // Find the dominant intent
  let maxType = 'factual';
  let maxScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxType = type;
    }
  }

  const totalSignals = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence = totalSignals > 0 ? maxScore / totalSignals : 0.3;

  return { type: maxType, confidence: Math.min(confidence, 1.0), entities, timeReferences };
}

// ---------------------------------------------------------------------------
// Dynamic Weight Adjustment
// ---------------------------------------------------------------------------

/** Default scorer weights (matching scorer.js CONFIG.weights) */
const BASE_WEIGHTS = {
  vector: 0.35,
  recency: 0.25,
  importance: 0.20,
  ebbinghaus: 0.05,
  matchBonus: 0.15
};

/**
 * Intent-specific weight multipliers.
 * These shift the scorer's attention based on what the user needs.
 */
const INTENT_WEIGHT_MODIFIERS = {
  temporal: { vector: 0.8, recency: 1.6, importance: 0.8, ebbinghaus: 0.8, matchBonus: 1.0 },
  action:   { vector: 1.0, recency: 1.2, importance: 1.3, ebbinghaus: 0.6, matchBonus: 1.0 },
  factual:  { vector: 1.2, recency: 0.8, importance: 1.0, ebbinghaus: 1.0, matchBonus: 1.2 },
  emotional:{ vector: 0.9, recency: 1.3, importance: 1.4, ebbinghaus: 0.5, matchBonus: 0.9 },
  exploratory: { vector: 1.1, recency: 0.7, importance: 1.0, ebbinghaus: 1.0, matchBonus: 1.2 }
};

/**
 * Memory type boost multipliers per intent.
 * Applied as a post-score multiplier to favor relevant memory types.
 */
const MEMORY_TYPE_BOOSTS = {
  temporal:    { event: 1.4, goal: 1.1, fact: 0.9, preference: 0.8, decision: 0.9, lesson: 0.8, relationship: 0.9 },
  action:      { lesson: 1.5, decision: 1.4, goal: 1.2, fact: 1.0, event: 0.8, preference: 0.9, relationship: 0.8 },
  factual:     { fact: 1.3, preference: 1.2, relationship: 1.1, event: 0.9, goal: 0.9, decision: 0.9, lesson: 0.9 },
  emotional:   { preference: 1.5, event: 1.3, goal: 1.1, lesson: 1.0, fact: 0.8, decision: 0.8, relationship: 0.7 },
  exploratory: { relationship: 1.4, lesson: 1.2, decision: 1.1, fact: 1.0, event: 1.0, goal: 0.9, preference: 0.8 }
};

/**
 * Compute dynamic scorer weights adjusted for the detected intent.
 *
 * @param {{ type: string, confidence: number }} intent
 * @returns {{ vector: number, recency: number, importance: number, ebbinghaus: number, matchBonus: number }}
 */
export function computeDynamicWeights(intent) {
  const modifiers = INTENT_WEIGHT_MODIFIERS[intent.type] || INTENT_WEIGHT_MODIFIERS.factual;
  const blendFactor = intent.confidence;

  // Blend between base weights and intent-modified weights
  const adjusted = {};
  let total = 0;
  for (const [key, base] of Object.entries(BASE_WEIGHTS)) {
    adjusted[key] = base * (1 - blendFactor + blendFactor * (modifiers[key] || 1.0));
    total += adjusted[key];
  }

  // Re-normalize to sum to 1.0
  for (const key of Object.keys(adjusted)) {
    adjusted[key] /= total;
  }

  return adjusted;
}

/**
 * Get the memory type boost multiplier for a given intent and memory type.
 *
 * @param {{ type: string }} intent
 * @param {string} memoryType
 * @returns {number} Multiplier (typically 0.7–1.5)
 */
export function getMemoryTypeBoost(intent, memoryType) {
  const boosts = MEMORY_TYPE_BOOSTS[intent.type] || MEMORY_TYPE_BOOSTS.factual;
  return boosts[memoryType] || 1.0;
}

// ---------------------------------------------------------------------------
// Cognitive Frame Assembly
// ---------------------------------------------------------------------------

/**
 * Priority tiers for cognitive frame assembly (per NotebookLM research):
 *   1. Anchor (Static Context): fact, preference — always injected
 *   2. Trajectory (Dynamic Context): goal, event — injected by recency
 *   3. Modifiers (Heuristics): decision, lesson — triggered by task similarity
 *   4. Connectors (Topology): relationship — used for reasoning queries
 */
const FRAME_TIERS = [
  { name: 'anchor', types: ['fact', 'preference'], priority: 4, description: 'Static user context — always present' },
  { name: 'trajectory', types: ['goal', 'event'], priority: 3, description: 'Dynamic situation — what is happening now' },
  { name: 'modifiers', types: ['decision', 'lesson'], priority: 2, description: 'Heuristics — past decisions and lessons learned' },
  { name: 'connectors', types: ['relationship'], priority: 1, description: 'Topology — graph edges for reasoning' }
];

/**
 * Estimate token count for a text string (rough: chars / 4).
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * CognitiveOperator — the executive function of the memory engine.
 *
 * Responsibilities:
 *   - Assemble structured cognitive frames from memory types
 *   - Detect query intent and adjust retrieval weights dynamically
 *   - Maintain symbolic coherence when new memories arrive
 *   - Prioritize memories for injection within a token budget
 */
export class CognitiveOperator {
  /**
   * @param {object} opts
   * @param {object} opts.store — PrismaGraphStore or InMemoryGraphStore
   */
  constructor({ store } = {}) {
    if (!store) throw new Error('CognitiveOperator requires a store');
    this.store = store;
  }

  /**
   * Assemble a cognitive frame from the user's active memories.
   * Groups memories by tier (anchor/trajectory/modifiers/connectors),
   * sorts within each tier by importance × recency, and returns a
   * structured frame object.
   *
   * @param {string} userId
   * @param {string} orgId
   * @param {{ query?: string, project?: string, maxTokens?: number }} options
   * @returns {Promise<{ frame: object, tokenCount: number, sections: Array, priorityMap: Map, intent: object }>}
   */
  async assembleFrame(userId, orgId, { query = '', project, maxTokens = 4000 } = {}) {
    const intent = detectQueryIntent(query);
    const dynamicWeights = computeDynamicWeights(intent);

    // Fetch all active memories for this user
    const allMemories = await this.store.listLatestMemories({
      user_id: userId,
      org_id: orgId,
      project: project || null
    });

    // Group by tier
    const sections = [];
    const priorityMap = new Map();
    let totalTokens = 0;

    for (const tier of FRAME_TIERS) {
      const tierMemories = allMemories
        .filter(m => tier.types.includes(m.memory_type))
        .map(m => {
          // Score each memory: combine recency and type boost
          const daysSinceUpdate = (Date.now() - new Date(m.updated_at || m.created_at).getTime()) / 86400000;
          const recencyScore = Math.pow(2, -daysSinceUpdate / 30);
          const typeBoost = getMemoryTypeBoost(intent, m.memory_type);
          const relevanceScore = recencyScore * typeBoost;

          // Entity boost: if query entities appear in content
          let entityBoost = 0;
          if (intent.entities.length > 0) {
            const contentLower = (m.content || '').toLowerCase();
            for (const entity of intent.entities) {
              if (contentLower.includes(entity.toLowerCase())) {
                entityBoost += 0.2;
              }
            }
          }

          const finalScore = relevanceScore + Math.min(entityBoost, 0.5);
          priorityMap.set(m.id, { relevance: finalScore, tier: tier.name, memoryType: m.memory_type });

          return { ...m, _frameScore: finalScore, _tokens: estimateTokens(m.content) };
        })
        .sort((a, b) => b._frameScore - a._frameScore);

      // Pack into budget
      const included = [];
      for (const m of tierMemories) {
        if (totalTokens + m._tokens > maxTokens) break;
        totalTokens += m._tokens;
        included.push(m);
      }

      if (included.length > 0) {
        sections.push({
          tier: tier.name,
          priority: tier.priority,
          description: tier.description,
          memories: included,
          tokenCount: included.reduce((s, m) => s + m._tokens, 0)
        });
      }
    }

    return {
      frame: this._buildFrameObject(sections),
      tokenCount: totalTokens,
      sections,
      priorityMap,
      intent,
      dynamicWeights
    };
  }

  /**
   * Check symbolic coherence: does the new memory contradict existing frame elements?
   *
   * @param {Array} frameMemories — current cognitive frame memories
   * @param {{ content: string, memory_type: string }} newMemory
   * @returns {{ coherent: boolean, conflicts: Array<{ memoryId: string, similarity: number, type: string }>, suggestedOperation: 'created'|'Updates'|'Extends' }}
   */
  maintainCoherence(frameMemories, newMemory) {
    const conflicts = [];
    let maxSimilarity = 0;
    let bestMatch = null;

    // Only check against same-type or fact/preference memories
    const checkTypes = new Set([newMemory.memory_type, 'fact', 'preference']);

    for (const existing of frameMemories) {
      if (!checkTypes.has(existing.memory_type)) continue;

      const similarity = computeTokenSimilarity(newMemory.content, existing.content);

      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        bestMatch = existing;
      }

      // High similarity with same type = potential conflict
      if (similarity > 0.60 && existing.memory_type === newMemory.memory_type) {
        conflicts.push({
          memoryId: existing.id,
          similarity,
          type: existing.memory_type,
          content: (existing.content || '').slice(0, 100)
        });
      }
    }

    // Determine suggested operation
    let suggestedOperation = 'created';
    if (maxSimilarity >= 0.85) {
      suggestedOperation = 'Updates'; // Strong overlap = supersession
    } else if (maxSimilarity >= 0.60) {
      suggestedOperation = 'Extends'; // Moderate overlap = extension
    }

    return {
      coherent: conflicts.length === 0,
      conflicts,
      suggestedOperation,
      maxSimilarity,
      bestMatchId: bestMatch?.id || null
    };
  }

  /**
   * Compute a relevance map for all memories given a query.
   * Uses intent detection + entity matching + type boosting.
   *
   * @param {string} query
   * @param {Array} memories
   * @returns {Map<string, { relevance: number, reason: string }>}
   */
  computeRelevanceMap(query, memories) {
    const intent = detectQueryIntent(query);
    const map = new Map();

    for (const m of memories) {
      const typeBoost = getMemoryTypeBoost(intent, m.memory_type);
      const contentLower = (m.content || '').toLowerCase();
      const queryLower = (query || '').toLowerCase();

      // Base similarity
      const tokenSim = computeTokenSimilarity(query, m.content);

      // Entity match bonus
      let entityScore = 0;
      for (const entity of intent.entities) {
        if (contentLower.includes(entity.toLowerCase())) entityScore += 0.15;
      }

      const relevance = Math.min((tokenSim * typeBoost) + entityScore, 1.0);

      const reasons = [];
      if (typeBoost > 1.1) reasons.push(`${m.memory_type} boosted for ${intent.type} intent`);
      if (entityScore > 0) reasons.push(`entity match (+${entityScore.toFixed(2)})`);
      if (tokenSim > 0.3) reasons.push(`content overlap (${tokenSim.toFixed(2)})`);

      map.set(m.id, { relevance, reason: reasons.join('; ') || 'baseline' });
    }

    return map;
  }

  /**
   * Select memories for prompt injection within a token budget.
   * Uses tiered priority: anchor > trajectory > modifiers > connectors.
   *
   * @param {{ sections: Array }} frame — from assembleFrame()
   * @param {number} contextBudget — max tokens to inject
   * @returns {{ injected: Array, totalTokens: number, dropped: Array }}
   */
  prioritizeForInjection(frame, contextBudget) {
    const injected = [];
    const dropped = [];
    let totalTokens = 0;

    // Process sections in priority order (highest first)
    const sorted = [...(frame.sections || [])].sort((a, b) => b.priority - a.priority);

    for (const section of sorted) {
      for (const m of section.memories) {
        const tokens = m._tokens || estimateTokens(m.content);
        if (totalTokens + tokens <= contextBudget) {
          totalTokens += tokens;
          injected.push({
            id: m.id,
            content: m.content,
            memory_type: m.memory_type,
            tier: section.tier,
            tokens
          });
        } else {
          dropped.push({
            id: m.id,
            memory_type: m.memory_type,
            tier: section.tier,
            tokens,
            reason: 'budget_exceeded'
          });
        }
      }
    }

    return { injected, totalTokens, dropped };
  }

  /**
   * Format injected memories into structured prompt text.
   *
   * @param {Array} injected — from prioritizeForInjection()
   * @returns {string}
   */
  formatInjectionPayload(injected) {
    if (!injected || injected.length === 0) return '';

    const grouped = {};
    for (const m of injected) {
      const tier = m.tier || 'general';
      if (!grouped[tier]) grouped[tier] = [];
      grouped[tier].push(m);
    }

    const lines = ['<cognitive-frame>'];
    const tierOrder = ['anchor', 'trajectory', 'modifiers', 'connectors', 'general'];

    for (const tier of tierOrder) {
      if (!grouped[tier]) continue;
      const tierLabel = FRAME_TIERS.find(t => t.name === tier)?.description || tier;
      lines.push(`  <${tier} description="${tierLabel}">`);
      for (const m of grouped[tier]) {
        lines.push(`    <memory type="${m.memory_type}">${m.content}</memory>`);
      }
      lines.push(`  </${tier}>`);
    }

    lines.push('</cognitive-frame>');
    return lines.join('\n');
  }

  /**
   * Assemble a stable observation prefix from all observation-type memories.
   * Mastra-style: chronological log of observations, token-budget capped.
   *
   * @param {string} userId
   * @param {string} orgId
   * @param {{ project?: string, maxTokens?: number }} options
   * @returns {Promise<{ prefix: string, tokenCount: number, observationCount: number }>}
   */
  async assembleObservationPrefix(userId, orgId, { project, maxTokens = 8000 } = {}) {
    const allMemories = await this.store.listLatestMemories({ user_id: userId, org_id: orgId, project });
    const observations = allMemories
      .filter(m => m.memory_type === 'observation')
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

    if (observations.length === 0) {
      return { prefix: '', tokenCount: 0, observationCount: 0 };
    }

    const lines = [];
    let tokens = 0;
    for (const obs of observations) {
      const line = obs.content || '';
      const lineTokens = Math.ceil(line.length / 4);
      if (tokens + lineTokens > maxTokens) break;
      lines.push(line);
      tokens += lineTokens;
    }

    const prefix = `<observation-log>\n${lines.join('\n')}\n</observation-log>`;
    return { prefix, tokenCount: tokens, observationCount: lines.length };
  }

  /**
   * Build a structured frame object from sections.
   * @param {Array} sections
   * @returns {object}
   */
  _buildFrameObject(sections) {
    const frame = {};
    for (const section of sections) {
      frame[section.tier] = {
        description: section.description,
        count: section.memories.length,
        tokenCount: section.tokenCount,
        memories: section.memories.map(m => ({
          id: m.id,
          content: m.content,
          memory_type: m.memory_type,
          score: m._frameScore,
          tags: m.tags || []
        }))
      };
    }
    return frame;
  }
}

// ---------------------------------------------------------------------------
// Chain-of-Note Injection
// ---------------------------------------------------------------------------

/**
 * Format memories for injection using the Chain-of-Note pattern.
 * Forces the LLM to write a brief note for each memory before reasoning,
 * improving reading accuracy by directing attention to relevance per item.
 *
 * @param {Array} memories — memory objects with id, content, memory_type, created_at
 * @param {string} query — the user's current query
 * @returns {string} Structured prompt payload
 */
export function formatChainOfNotePayload(memories, query) {
  const memoryJSON = memories.map((m, i) => ({
    id: m.id,
    type: m.memory_type || 'fact',
    date: m.created_at || m.document_date || null,
    content: (m.content || '').slice(0, 1000),
  }));

  return `<chain-of-note>
<query>${query}</query>
<memories>
${JSON.stringify(memoryJSON, null, 2)}
</memories>
<INSTRUCTIONS>
You have been given relevant memories from the user's knowledge graph.
Follow this exact process:
1. For EACH memory above, write a brief note: what information does it contain that is relevant to the query? If it is not relevant, write "Not relevant."
2. After processing all memories, reason over your notes to synthesize the final answer.
3. If memories contain conflicting information, prefer the most recent date.
4. If no memory contains the answer, say "I don't have information about this in my memory."
</INSTRUCTIONS>
</chain-of-note>`;
}

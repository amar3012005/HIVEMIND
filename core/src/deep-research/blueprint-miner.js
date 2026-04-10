/**
 * BlueprintMiner — Detects reusable research patterns from completed trails
 * and stores them as kg/blueprint nodes in the CSI graph.
 *
 * Pattern Detection Approach:
 * 1. Cluster similar trails by query embedding or keyword similarity
 * 2. Extract common action sequences (find repeated subsequences)
 * 3. Score blueprint quality (success rate, avg confidence, reuse count)
 * 4. Detect blueprint candidates (trails with high confidence following similar patterns)
 *
 * Blueprint Templates Supported:
 * - Regulatory Research: find primary source → extract obligations → compare commentary → synthesize impact
 * - Competitive Research: collect product docs → extract features → compare claims → map positioning gaps
 * - Technical Investigation: gather code/docs/issues → detect anomaly clusters → form hypotheses → verify
 * - Literature Review: search papers → extract claims → group by stance → identify contradictions → summarize
 */

import { randomUUID } from 'node:crypto';

const MIN_TRAILS_FOR_PATTERN = 2;        // Minimum trails to detect a pattern
const MIN_PATTERN_CONFIDENCE = 0.6;      // Minimum confidence to consider a pattern
const BLUEPRINT_VERSION = 1;

// Action type mapping from research actions
const ACTION_TYPE_MAP = {
  'search_web': 'search_web',
  'search_memory': 'search_memory',
  'read_url': 'read_url',
  'synthesize': 'synthesize',
  'finish': 'finish',
};

// Phase detection based on task dimension and depth
function detectPhase(task, taskIndex, totalTasks) {
  if (taskIndex === 0 && task.depth === 0) return 'exploration';
  if (task.dimension === 'definition' || task.depth === 1) return 'exploration';
  if (task.dimension === 'mechanism' || task.dimension === 'evidence') return 'analysis';
  if (task.dimension === 'comparison' || task.dimension === 'gaps') return 'verification';
  if (task.dimension === 'implications' || taskIndex === totalTasks - 1) return 'synthesis';
  return 'analysis';
}

// Agent role detection based on phase and dimension
function detectAgent(phase, dimension) {
  switch (phase) {
    case 'exploration': return 'explorer';
    case 'analysis': return 'analyst';
    case 'verification': return 'verifier';
    case 'synthesis': return 'synthesizer';
    default: return 'analyst';
  }
}

// Domain detection from query keywords
function detectDomain(query, findings) {
  const q = query.toLowerCase();
  const allText = q + ' ' + (findings || []).map(f => f.content || '').join(' ').toLowerCase();

  if (allText.includes('regulat') || allText.includes('compliance') || allText.includes('gdpr') ||
      allText.includes('eu ai act') || allText.includes('obligation') || allText.includes('legal')) {
    return 'regulatory';
  }
  if (allText.includes('competitor') || allText.includes('product') || allText.includes('feature') ||
      allText.includes('market') || allText.includes('positioning')) {
    return 'competitive';
  }
  if (allText.includes('bug') || allText.includes('issue') || allText.includes('code') ||
      allText.includes('technical') || allText.includes('anomaly')) {
    return 'technical';
  }
  if (allText.includes('paper') || allText.includes('literature') || allText.includes('academic') ||
      allText.includes('research study')) {
    return 'academic';
  }
  return null;
}

// Generate query template from task queries
function generateQueryTemplate(queries) {
  if (!queries || queries.length === 0) return '';

  // Find common patterns in queries
  const normalized = queries.map(q => q.toLowerCase());
  const words = normalized.map(q => q.split(/\s+/));

  // Find common words (excluding stop words)
  const stopWords = new Set(['what', 'how', 'when', 'where', 'why', 'the', 'a', 'an', 'is', 'are', 'be', 'to', 'of', 'in', 'for', 'on', 'with']);
  const wordCounts = new Map();

  for (const wordList of words) {
    const seen = new Set();
    for (const word of wordList) {
      const clean = word.replace(/[^a-z]/g, '');
      if (clean.length > 2 && !stopWords.has(clean) && !seen.has(clean)) {
        wordCounts.set(clean, (wordCounts.get(clean) || 0) + 1);
        seen.add(clean);
      }
    }
  }

  // Build template from common words
  const commonWords = [...wordCounts.entries()]
    .filter(([_, count]) => count >= Math.ceil(queries.length / 2))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  if (commonWords.length === 0) return queries[0] || '';

  // Create template with placeholder
  return `${commonWords.join(' ')} {topic}`;
}

// Find longest common subsequence of action patterns
function findCommonPatterns(trailPatterns) {
  if (trailPatterns.length === 0) return [];
  if (trailPatterns.length === 1) return trailPatterns[0];

  // Simple approach: find actions that appear in >50% of trails at similar positions
  const maxLength = Math.max(...trailPatterns.map(p => p.length));
  const positionVotes = new Map(); // position -> action -> count

  for (const pattern of trailPatterns) {
    for (let i = 0; i < pattern.length; i++) {
      const action = pattern[i];
      const bucket = Math.floor(i / 2); // Group positions in pairs for flexibility
      const key = `${bucket}-${action.actionType}`;
      positionVotes.set(key, (positionVotes.get(key) || 0) + 1);
    }
  }

  // Build consensus pattern
  const consensus = [];
  const minSupport = Math.ceil(trailPatterns.length * 0.5);

  for (let bucket = 0; bucket < Math.ceil(maxLength / 2); bucket++) {
    let bestAction = null;
    let bestCount = 0;

    for (const [key, count] of positionVotes.entries()) {
      if (key.startsWith(`${bucket}-`) && count > bestCount) {
        bestCount = count;
        const actionType = key.split('-')[1];
        bestAction = trailPatterns
          .flatMap(p => p.filter(a => a.actionType === actionType))
          .find(a => a.actionType === actionType);
      }
    }

    if (bestAction && bestCount >= minSupport) {
      consensus.push({ ...bestAction, support: bestCount / trailPatterns.length });
    }
  }

  return consensus;
}

// Calculate pattern similarity between two trails
function calculatePatternSimilarity(pattern1, pattern2) {
  if (!pattern1 || !pattern2 || pattern1.length === 0 || pattern2.length === 0) return 0;

  // Count matching action types
  const actions1 = pattern1.map(p => p.actionType);
  const actions2 = pattern2.map(p => p.actionType);

  let matches = 0;
  for (const action of actions1) {
    if (actions2.includes(action)) matches++;
  }

  return (2 * matches) / (actions1.length + actions2.length);
}

// Cluster trails by pattern similarity
function clusterTrailsByPattern(trails) {
  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < trails.length; i++) {
    if (assigned.has(i)) continue;

    const cluster = [trails[i]];
    assigned.add(i);

    for (let j = i + 1; j < trails.length; j++) {
      if (assigned.has(j)) continue;

      const similarity = calculatePatternSimilarity(trails[i].pattern, trails[j].pattern);
      if (similarity >= 0.6) {
        cluster.push(trails[j]);
        assigned.add(j);
      }
    }

    if (cluster.length >= MIN_TRAILS_FOR_PATTERN) {
      clusters.push(cluster);
    }
  }

  return clusters;
}

export class BlueprintMiner {
  /**
   * @param {Object} deps
   * @param {import('../memory/prisma-graph-store.js').PrismaGraphStore} deps.memoryStore
   * @param {Object} deps.prisma - Prisma client
   */
  constructor({ memoryStore, prisma }) {
    this.memoryStore = memoryStore;
    this.prisma = prisma;
  }

  /**
   * Extract action pattern from a trail.
   * @param {Object} trail - Trail data from CSI
   * @returns {Array} Array of pattern steps
   */
  extractPattern(trail) {
    const tasks = trail?.tasks || {};
    const taskList = Object.values(tasks).sort((a, b) =>
      new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
    );

    const pattern = [];
    for (let i = 0; i < taskList.length; i++) {
      const task = taskList[i];
      const phase = detectPhase(task, i, taskList.length);
      const agent = detectAgent(phase, task.dimension);

      // Determine action type from findings
      let actionType = 'search_web';
      if (task.findings?.length > 0) {
        const findingTypes = task.findings.map(f => f.type || f.research_type);
        if (findingTypes.includes('memory')) actionType = 'search_memory';
        else if (findingTypes.includes('follow_up')) actionType = 'read_url';
        else if (findingTypes.includes('synthesis')) actionType = 'synthesize';
      }

      pattern.push({
        phase,
        agent,
        actionType,
        queryTemplate: task.query ? this._generateQueryTemplate(task.query) : null,
        expectedOutput: this._inferExpectedOutput(task.dimension, task.findings),
        minConfidence: task.confidence || 0.5,
      });
    }

    return pattern;
  }

  _generateQueryTemplate(query) {
    if (!query) return '';
    // Replace specific entities with placeholder
    return query
      .replace(/\b[A-Z][a-z]+ (Inc|Corp|LLC|Ltd|GmbH)\b/gi, '{entity}')
      .replace(/\b\d{4}\b/g, '{year}')
      .replace(/\b[A-Z]{2,}\b/g, '{acronym}')
      .trim();
  }

  _inferExpectedOutput(dimension, findings) {
    const outputMap = {
      'definition': 'key concept definitions',
      'mechanism': 'process explanation',
      'evidence': 'supporting data or quotes',
      'stakeholders': 'stakeholder list',
      'timeline': 'chronological events',
      'comparison': 'comparison table or analysis',
      'implications': 'impact assessment',
      'gaps': 'unanswered questions',
    };
    return outputMap[dimension] || 'research findings';
  }

  /**
   * Mine blueprints from completed research trails.
   * @param {string} userId
   * @param {string} orgId
   * @param {Object} options
   * @returns {Promise<Array>} List of mined blueprints
   */
  async mine(userId, orgId, options = {}) {
    const { minConfidence = 0.7, limit = 10 } = options;

    // Fetch completed research trails
    const trails = await this._fetchCompletedTrails(userId, orgId, minConfidence);
    if (trails.length === 0) return [];

    // Extract patterns from each trail
    const trailPatterns = trails.map(trail => ({
      trail,
      pattern: this.extractPattern(trail),
      domain: detectDomain(trail.query, trail.findings),
      successRate: trail.confidence || 0,
    }));

    // Group by domain
    const domainGroups = new Map();
    for (const tp of trailPatterns) {
      const domain = tp.domain || 'general';
      if (!domainGroups.has(domain)) domainGroups.set(domain, []);
      domainGroups.get(domain).push(tp);
    }

    // Mine blueprints from each domain group
    const blueprints = [];
    for (const [domain, group] of domainGroups.entries()) {
      if (group.length < MIN_TRAILS_FOR_PATTERN) continue;

      // Cluster by pattern similarity
      const clusters = clusterTrailsByPattern(group.map(g => ({ pattern: g.pattern, trail: g.trail })));

      for (const cluster of clusters) {
        const blueprint = this._createBlueprint(domain, cluster);
        if (blueprint) {
          blueprints.push(blueprint);
        }
      }

      // If no clear clusters but enough trails, create a general blueprint
      if (clusters.length === 0 && group.length >= MIN_TRAILS_FOR_PATTERN) {
        const blueprint = this._createBlueprint(domain, group);
        if (blueprint) {
          blueprints.push(blueprint);
        }
      }
    }

    // Save blueprints to CSI
    const saved = [];
    for (const bp of blueprints.slice(0, limit)) {
      const savedBp = await this.saveBlueprint(bp, userId, orgId);
      if (savedBp) saved.push(savedBp);
    }

    return saved;
  }

  /**
   * Fetch completed research trails from CSI.
   */
  async _fetchCompletedTrails(userId, orgId, minConfidence) {
    try {
      // Query for research trail memories
      const result = await this.prisma.memory.findMany({
        where: {
          userId,
          orgId,
          tags: { has: 'research-trail' },
          deletedAt: null,
        },
        include: {
          sourceMetadata: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      // Filter by confidence and extract trail data
      const trails = [];
      for (const memory of result) {
        const trail = memory.metadata?.trail;
        if (trail && trail.progress?.confidence >= minConfidence) {
          trails.push({
            id: memory.id,
            query: memory.content?.split('\n')[0]?.replace('Research Trail: ', '') || 'Unknown',
            tasks: trail.tasks || {},
            findings: this._extractFindingsFromMemory(memory),
            confidence: trail.progress.confidence,
            report: memory.content,
            createdAt: memory.createdAt,
            metadata: memory.metadata,
          });
        }
      }

      return trails;
    } catch (err) {
      console.error('[BlueprintMiner] Failed to fetch trails:', err.message);
      return [];
    }
  }

  _extractFindingsFromMemory(memory) {
    // Findings are stored as separate memories linked by project
    // For now, return empty - could be enhanced to fetch related findings
    return [];
  }

  /**
   * Create a blueprint from a cluster of similar trails.
   */
  _createBlueprint(domain, cluster) {
    if (cluster.length === 0) return null;

    const trails = cluster.map(c => c.trail || c);
    const patterns = cluster.map(c => c.pattern || this.extractPattern(c.trail || c));

    // Find common pattern
    const commonPattern = findCommonPatterns(patterns);
    if (commonPattern.length === 0) return null;

    // Calculate statistics
    const successRates = trails.map(t => t.confidence || 0);
    const avgSuccessRate = successRates.reduce((a, b) => a + b, 0) / successRates.length;

    const avgConfidence = patterns.reduce((sum, p) =>
      sum + p.reduce((s, step) => s + (step.minConfidence || 0), 0) / p.length, 0
    ) / patterns.length;

    // Generate blueprint name from domain and pattern
    const name = this._generateBlueprintName(domain, commonPattern);

    return {
      blueprintId: randomUUID(),
      name,
      version: BLUEPRINT_VERSION,
      pattern: commonPattern.map(step => ({
        phase: step.phase,
        agent: step.agent,
        actionType: step.actionType,
        queryTemplate: step.queryTemplate,
        expectedOutput: step.expectedOutput,
        minConfidence: step.minConfidence || MIN_PATTERN_CONFIDENCE,
      })),
      domain: domain === 'general' ? null : domain,
      successRate: avgSuccessRate,
      timesReused: 0,
      avgConfidence,
      sourceTrailIds: trails.map(t => t.id).filter(Boolean),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
    };
  }

  _generateBlueprintName(domain, pattern) {
    const domainNames = {
      'regulatory': 'Regulatory Analysis',
      'competitive': 'Competitive Research',
      'technical': 'Technical Investigation',
      'academic': 'Literature Review',
      'general': 'Research Pattern',
    };

    const baseName = domainNames[domain] || 'Research Pattern';

    // Add pattern characteristics
    const actions = pattern.map(p => p.actionType).filter((v, i, a) => a.indexOf(v) === i);
    if (actions.includes('read_url')) {
      return `${baseName} (Deep Read)`;
    }
    if (actions.includes('search_memory')) {
      return `${baseName} (Memory-Augmented)`;
    }

    return baseName;
  }

  /**
   * Save a blueprint to CSI graph as kg/blueprint node.
   */
  async saveBlueprint(blueprint, userId, orgId) {
    try {
      const memoryId = randomUUID();

      await this.memoryStore.createMemory({
        id: memoryId,
        user_id: userId,
        org_id: orgId,
        content: JSON.stringify(blueprint.pattern, null, 2),
        title: `Blueprint: ${blueprint.name}`,
        memory_type: 'lesson',
        tags: ['kg/blueprint', 'research-blueprint', blueprint.domain ? `domain:${blueprint.domain}` : 'domain:general'],
        is_latest: true,
        importance_score: blueprint.successRate,
        metadata: {
          blueprint_id: blueprint.blueprintId,
          blueprint_name: blueprint.name,
          blueprint_version: blueprint.version,
          blueprint_domain: blueprint.domain,
          blueprint_success_rate: blueprint.successRate,
          blueprint_times_reused: blueprint.timesReused,
          blueprint_avg_confidence: blueprint.avgConfidence,
          blueprint_pattern: blueprint.pattern,
          blueprint_source_trails: blueprint.sourceTrailIds,
          blueprint_created_at: blueprint.createdAt,
          blueprint_updated_at: blueprint.updatedAt,
          blueprint_last_used_at: blueprint.lastUsedAt,
        },
        created_at: blueprint.createdAt,
        updated_at: blueprint.updatedAt,
      });

      return { ...blueprint, _memoryId: memoryId };
    } catch (err) {
      console.error('[BlueprintMiner] Failed to save blueprint:', err.message);
      return null;
    }
  }

  /**
   * Capture full research state for reusable blueprint.
   * Captures trails, memories, sources, findings, and graph structure.
   * @param {string} sessionId - Research session ID
   * @param {string} userId
   * @param {string} orgId
   * @param {string} projectId
   * @returns {Promise<Object|null>} Captured state or null
   */
  async captureResearchState(sessionId, userId, orgId, projectId) {
    try {
      // Fetch all memories for this research project
      const memories = await this.memoryStore.searchMemories({
        query: '',
        user_id: userId,
        org_id: orgId,
        project: projectId,
        n_results: 500,
      });

      // Categorize memories
      const state = {
        sessionId,
        projectId,
        capturedAt: new Date().toISOString(),
        sources: [],
        findings: [],
        trails: [],
        observations: [],
        executionEvents: [],
        contradictions: [],
        blueprints: [],
        graph: { nodes: [], edges: [] },
      };

      (memories || []).forEach(m => {
        const tags = m.tags || [];
        const metadata = m.metadata || {};

        // Sources
        if (tags.includes('research-source') || tags.includes('web-source') ||
            metadata.source_type === 'web' || m.memory_type === 'fact' && tags.includes('web')) {
          state.sources.push({
            id: m.id,
            title: m.title,
            url: metadata.url || metadata.source_url,
            content: m.content,
            score: m.importance_score,
          });
        }

        // Findings
        if (tags.includes('research-finding') || m.memory_type === 'fact') {
          state.findings.push({
            id: m.id,
            title: m.title,
            content: m.content,
            confidence: metadata.confidence || m.importance_score,
            source: metadata.source_url,
            type: metadata.research_type,
          });
        }

        // Trails
        if (tags.includes('research-trail') || metadata.trailType === 'op/research-trail' || m.memory_type === 'decision') {
          state.trails.push({
            id: m.id,
            query: metadata.query || m.content?.split('\n')[0],
            steps: metadata.steps || [],
            confidence: metadata.progress?.confidence,
            status: metadata.status,
          });
        }

        // Observations
        if (tags.includes('research-observation') || metadata.observationType === 'op/research-observation') {
          state.observations.push({
            id: m.id,
            agent: metadata.agent,
            action: metadata.action,
            findingType: metadata.findingType,
            source: metadata.source,
            sourceId: metadata.sourceId,
            confidence: metadata.confidence,
            stepIndex: metadata.stepIndex,
          });
        }

        // Execution Events
        if (tags.includes('research-execution-event') || metadata.executionEventType === 'op/research-execution-event') {
          state.executionEvents.push({
            id: m.id,
            agent: metadata.agent,
            action: metadata.action,
            output: metadata.output,
            success: metadata.success,
          });
        }

        // Contradictions
        if (tags.includes('research-contradiction') || metadata.contradictionType === 'op/research-contradiction') {
          state.contradictions.push({
            id: m.id,
            claimA: metadata.claimA,
            claimB: metadata.claimB,
            dimension: metadata.dimension,
            unresolved: metadata.unresolved,
          });
        }

        // Blueprints
        if (tags.includes('kg/blueprint') || metadata.blueprint_id) {
          state.blueprints.push({
            blueprintId: metadata.blueprint_id,
            name: metadata.blueprint_name,
            domain: metadata.blueprint_domain,
            timesReused: metadata.blueprint_times_reused,
          });
        }
      });

      // Build graph structure
      state.graph.nodes = [
        ...state.sources.map(s => ({ id: s.id, type: 'source', ...s })),
        ...state.findings.map(f => ({ id: f.id, type: 'finding', ...f })),
        ...state.trails.map(t => ({ id: t.id, type: 'trail', ...t })),
      ];

      return state;
    } catch (err) {
      console.error('[BlueprintMiner] Failed to capture research state:', err.message);
      return null;
    }
  }

  /**
   * Save blueprint with captured research state.
   * @param {Object} blueprint
   * @param {string} userId
   * @param {string} orgId
   * @param {Object} capturedState - Optional captured research state
   */
  async saveBlueprintWithState(blueprint, userId, orgId, capturedState) {
    try {
      const memoryId = randomUUID();
      const tags = ['kg/blueprint', 'research-blueprint'];
      if (blueprint.domain) tags.push(`domain:${blueprint.domain}`);

      await this.memoryStore.createMemory({
        id: memoryId,
        user_id: userId,
        org_id: orgId,
        content: JSON.stringify(blueprint.pattern, null, 2),
        title: `Blueprint: ${blueprint.name}`,
        memory_type: 'lesson',
        tags,
        is_latest: true,
        importance_score: blueprint.successRate,
        metadata: {
          blueprint_id: blueprint.blueprintId,
          blueprint_name: blueprint.name,
          blueprint_version: blueprint.version,
          blueprint_domain: blueprint.domain,
          blueprint_success_rate: blueprint.successRate,
          blueprint_times_reused: blueprint.timesReused,
          blueprint_avg_confidence: blueprint.avgConfidence,
          blueprint_pattern: blueprint.pattern,
          blueprint_source_trails: blueprint.sourceTrailIds,
          blueprint_created_at: blueprint.createdAt,
          blueprint_updated_at: blueprint.updatedAt,
          blueprint_last_used_at: blueprint.lastUsedAt,
          // Captured research state for reusability
          blueprint_has_captured_state: !!capturedState,
          blueprint_captured_state: capturedState ? {
            sessionId: capturedState.sessionId,
            projectId: capturedState.projectId,
            capturedAt: capturedState.capturedAt,
            sourceCount: capturedState.sources?.length || 0,
            findingCount: capturedState.findings?.length || 0,
            trailCount: capturedState.trails?.length || 0,
            observationCount: capturedState.observations?.length || 0,
            graphNodeCount: capturedState.graph?.nodes?.length || 0,
          } : null,
        },
        created_at: blueprint.createdAt,
        updated_at: blueprint.updatedAt,
      });

      return { ...blueprint, _memoryId: memoryId, capturedState };
    } catch (err) {
      console.error('[BlueprintMiner] Failed to save blueprint with state:', err.message);
      return null;
    }
  }

  /**
   * Get blueprints by domain or all.
   */
  async getBlueprints(userId, orgId, domain = null) {
    try {
      const where = {
        userId,
        orgId,
        tags: { has: 'kg/blueprint' },
        deletedAt: null,
      };

      if (domain) {
        where.tags = { has: `domain:${domain}` };
      }

      const result = await this.prisma.memory.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });

      return result.map(m => this._memoryToBlueprint(m));
    } catch (err) {
      console.error('[BlueprintMiner] Failed to get blueprints:', err.message);
      return [];
    }
  }

  /**
   * Get a specific blueprint by ID.
   */
  async getBlueprintById(userId, orgId, blueprintId) {
    try {
      const result = await this.prisma.memory.findFirst({
        where: {
          userId,
          orgId,
          metadata: {
            path: ['blueprint_id'],
            equals: blueprintId,
          },
          deletedAt: null,
        },
      });

      if (!result) return null;
      return this._memoryToBlueprint(result);
    } catch (err) {
      console.error('[BlueprintMiner] Failed to get blueprint:', err.message);
      return null;
    }
  }

  /**
   * Increment reuse count for a blueprint.
   */
  async incrementReuseCount(userId, orgId, blueprintId) {
    try {
      const memory = await this.prisma.memory.findFirst({
        where: {
          userId,
          orgId,
          metadata: {
            path: ['blueprint_id'],
            equals: blueprintId,
          },
          deletedAt: null,
        },
      });

      if (!memory) return null;

      const blueprint = this._memoryToBlueprint(memory);
      const newCount = (blueprint.timesReused || 0) + 1;

      await this.memoryStore.updateMemory(memory.id, {
        metadata: {
          ...memory.metadata,
          blueprint_times_reused: newCount,
          blueprint_last_used_at: new Date().toISOString(),
        },
        importance_score: Math.min(1.0, (blueprint.importance_score || 0.5) + 0.05),
      });

      return { ...blueprint, timesReused: newCount, lastUsedAt: new Date().toISOString() };
    } catch (err) {
      console.error('[BlueprintMiner] Failed to increment reuse count:', err.message);
      return null;
    }
  }

  /**
   * Update blueprint statistics after reuse.
   */
  async updateBlueprintStats(userId, orgId, blueprintId, { success, confidence }) {
    try {
      const memory = await this.prisma.memory.findFirst({
        where: {
          userId,
          orgId,
          metadata: {
            path: ['blueprint_id'],
            equals: blueprintId,
          },
          deletedAt: null,
        },
      });

      if (!memory) return null;

      const blueprint = this._memoryToBlueprint(memory);
      const currentSuccess = blueprint.successRate || 0;
      const currentConfidence = blueprint.avgConfidence || 0;
      const timesReused = blueprint.timesReused || 1;

      // Update with exponential moving average
      const alpha = 0.3;
      const newSuccessRate = (1 - alpha) * currentSuccess + alpha * (success ? 1 : 0);
      const newAvgConfidence = (1 - alpha) * currentConfidence + alpha * (confidence || 0.5);

      await this.memoryStore.updateMemory(memory.id, {
        metadata: {
          ...memory.metadata,
          blueprint_success_rate: newSuccessRate,
          blueprint_avg_confidence: newAvgConfidence,
          blueprint_updated_at: new Date().toISOString(),
        },
        importance_score: newSuccessRate,
      });

      return {
        ...blueprint,
        successRate: newSuccessRate,
        avgConfidence: newAvgConfidence,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.error('[BlueprintMiner] Failed to update blueprint stats:', err.message);
      return null;
    }
  }

  /**
   * Suggest blueprints for a query based on domain detection.
   */
  async suggestBlueprints(userId, orgId, query) {
    const domain = detectDomain(query, []);
    const blueprints = await this.getBlueprints(userId, orgId, domain);

    // Also get general blueprints
    if (domain) {
      const general = await this.getBlueprints(userId, orgId, null);
      const generalNotInDomain = general.filter(b => !blueprints.find(bp => bp.blueprintId === b.blueprintId));
      blueprints.push(...generalNotInDomain);
    }

    // Score and sort by relevance
    const scored = blueprints.map(bp => ({
      ...bp,
      relevanceScore: this._calculateRelevanceScore(bp, query),
    }));

    return scored.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, 5);
  }

  _calculateRelevanceScore(blueprint, query) {
    let score = blueprint.successRate || 0.5;

    // Boost for domain match
    if (blueprint.domain && detectDomain(query, []).includes(blueprint.domain)) {
      score += 0.2;
    }

    // Boost for reuse count (social proof)
    score += Math.min(0.15, (blueprint.timesReused || 0) * 0.03);

    // Boost for confidence
    score += (blueprint.avgConfidence || 0.5) * 0.1;

    return Math.min(1.0, score);
  }

  _memoryToBlueprint(memory) {
    const m = memory.metadata || {};
    return {
      blueprintId: m.blueprint_id,
      name: m.blueprint_name || memory.title?.replace('Blueprint: ', ''),
      version: m.blueprint_version || 1,
      pattern: m.blueprint_pattern || [],
      domain: m.blueprint_domain,
      successRate: m.blueprint_success_rate || 0,
      timesReused: m.blueprint_times_reused || 0,
      avgConfidence: m.blueprint_avg_confidence || 0,
      sourceTrailIds: m.blueprint_source_trails || [],
      createdAt: m.blueprint_created_at || memory.createdAt,
      updatedAt: m.blueprint_updated_at || memory.updatedAt,
      lastUsedAt: m.blueprint_last_used_at,
      _memoryId: memory.id,
    };
  }
}

export { detectDomain, detectPhase, detectAgent };

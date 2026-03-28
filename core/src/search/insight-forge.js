/**
 * InsightForge - Deep Multi-Dimensional Analysis
 *
 * LLM-powered sub-query generation and multi-dimensional result aggregation.
 * Extracts entities, builds relationship chains, and generates semantic facts.
 *
 * @module search/insight-forge
 * @requires search/hybrid
 * @requires recall/ranker
 * @requires recall/scorer
 */

import hybridSearch from './hybrid.js';
import ranker from '../recall/ranker.js';
const { rank } = ranker;
import scorer from '../recall/scorer.js';
const { scoreAndRank } = scorer;

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // LLM configuration
  llm: {
    model: 'llama-3.3-70b-versatile',
    temperature: 0.3,
    maxTokens: 2048,
    subQueryTemperature: 0.5
  },

  // Sub-query generation
  subQueries: {
    minCount: 3,
    maxCount: 7,
    defaultCount: 5
  },

  // Entity extraction
  entities: {
    minConfidence: 0.6,
    maxEntities: 20,
    types: ['person', 'organization', 'concept', 'event', 'location', 'technology']
  },

  // Relationship chains
  chains: {
    maxDepth: 3,
    minConfidence: 0.5,
    maxChains: 10
  },

  // Result aggregation
  aggregation: {
    deduplicationThreshold: 0.85,
    minResultScore: 0.2,
    boostForMultipleMatches: 0.1
  }
};

// ==========================================
// Logger
// ==========================================

const logger = {
  info: (msg, ctx) => console.log(`[INSIGHT-FORGE INFO] ${msg}`, ctx || {}),
  warn: (msg, ctx) => console.warn(`[INSIGHT-FORGE WARN] ${msg}`, ctx || {}),
  error: (msg, ctx) => console.error(`[INSIGHT-FORGE ERROR] ${msg}`, ctx || {}),
  debug: (msg, ctx) => console.debug(`[INSIGHT-FORGE DEBUG] ${msg}`, ctx || {})
};

// ==========================================
// System Prompts
// ==========================================

const SUBQUERY_SYSTEM_PROMPT = `You are an expert at decomposing complex queries into focused sub-queries for memory retrieval.

Your task is to analyze the user's query and break it down into 3-7 specific sub-queries that:
1. Cover different aspects or dimensions of the original query
2. Are specific enough to retrieve relevant memories
3. Together provide comprehensive coverage of the topic

Output format (JSON):
{
  "subQueries": [
    {
      "query": "specific sub-query text",
      "focus": "what aspect this covers",
      "weight": 0.25
    }
  ],
  "reasoning": "brief explanation of decomposition strategy"
}

Guidelines:
- Each sub-query should be self-contained and searchable
- Weights should sum to 1.0
- Include temporal aspects if relevant (recent, historical)
- Include entity-focused queries for specific people/organizations
- Include relationship-focused queries for connections`;

const ENTITY_EXTRACTION_PROMPT = `You are an expert at extracting entities and their relationships from text.

Analyze the provided memories and extract:
1. Named entities (people, organizations, concepts, events, locations, technologies)
2. Relationships between entities
3. Key attributes of each entity

Output format (JSON):
{
  "entities": [
    {
      "name": "entity name",
      "type": "person|organization|concept|event|location|technology",
      "confidence": 0.9,
      "mentions": 3,
      "attributes": {"key": "value"},
      "relatedEntities": ["entity1", "entity2"]
    }
  ],
  "relationships": [
    {
      "from": "entity1",
      "to": "entity2",
      "type": "relationship type",
      "confidence": 0.8,
      "evidence": "supporting text"
    }
  ]
}

Guidelines:
- Only include entities with confidence >= 0.6
- Capture implicit relationships from context
- Track mention counts across all memories
- Identify key attributes from surrounding text`;

const ANALYSIS_PROMPT = `You are an expert analyst synthesizing information from multiple memories.

Analyze the provided query results and generate:
1. Key semantic facts extracted from the memories
2. Patterns and trends across the results
3. Insights that answer the original query
4. Gaps in the available information

Output format (JSON):
{
  "semanticFacts": [
    {
      "fact": "clear statement of fact",
      "confidence": 0.85,
      "supportingMemories": ["id1", "id2"],
      "category": "fact|inference|hypothesis"
    }
  ],
  "patterns": [
    {
      "pattern": "description of pattern",
      "evidence": "supporting evidence",
      "significance": "why this matters"
    }
  ],
  "insights": [
    {
      "insight": "key insight",
      "relevance": 0.9,
      "explanation": "detailed explanation"
    }
  ],
  "gaps": ["missing information that would be helpful"]
}

Guidelines:
- Distinguish between explicit facts and inferred insights
- Cite specific memory IDs for support
- Identify contradictions or conflicting information
- Note confidence levels honestly`;

// ==========================================
// InsightForge Class
// ==========================================

/**
 * InsightForge - Deep Multi-Dimensional Analysis Engine
 *
 * Uses LLM to:
 * 1. Generate sub-queries for comprehensive coverage
 * 2. Extract entities and relationships
 * 3. Build relationship chains
 * 4. Synthesize semantic facts and insights
 */
export class InsightForge {
  /**
   * Create an InsightForge instance
   *
   * @param {Object} options - Configuration options
   * @param {Object} options.vectorStore - Vector store instance
   * @param {Object} options.graphStore - Graph store instance
   * @param {Object} options.llmClient - LLM client (Groq)
   * @param {Object} options.config - Optional configuration overrides
   */
  constructor(options = {}) {
    this.vectorStore = options.vectorStore;
    this.graphStore = options.graphStore;
    this.llmClient = options.llmClient;
    this.config = { ...CONFIG, ...(options.config || {}) };

    logger.info('InsightForge initialized', {
      hasLLM: !!this.llmClient,
      model: this.config.llm.model
    });
  }

  // ==========================================
  // Main Analysis Method
  // ==========================================

  /**
   * Perform deep analysis of a query
   *
   * @param {string} query - Original search query
   * @param {Object} options - Analysis options
   * @param {string} options.userId - User ID (required)
   * @param {string} options.orgId - Organization ID
   * @param {string} [options.simulationRequirement] - Additional context
   * @param {number} [options.subQueryLimit=5] - Maximum sub-queries
   * @param {number} [options.resultsPerSubQuery=15] - Results per sub-query
   * @param {boolean} [options.includeAnalysis=true] - Include LLM synthesis
   * @returns {Promise<Object>} Comprehensive analysis results
   */
  async analyze(query, options = {}) {
    const startTime = Date.now();
    const requestId = crypto.randomUUID();

    const {
      userId,
      orgId,
      project,
      simulationRequirement,
      subQueryLimit = this.config.subQueries.defaultCount,
      resultsPerSubQuery = 15,
      includeAnalysis = true
    } = options;

    logger.info('Starting InsightForge analysis', {
      requestId,
      query,
      userId,
      subQueryLimit
    });

    if (!this.llmClient) {
      throw new Error('LLM client is required for InsightForge analysis');
    }

    try {
      // Step 1: Generate sub-queries using LLM
      const subQueries = await this.generateSubQueries(query, {
        simulationRequirement,
        limit: subQueryLimit
      });

      // Step 2: Search for each sub-query
      const subQueryResults = await this.searchSubQueries(subQueries, {
        userId,
        orgId,
        project,
        limit: resultsPerSubQuery
      });

      // Step 3: Aggregate and deduplicate results
      const aggregatedResults = this.aggregateResults(subQueryResults);

      // Step 4: Extract entities from aggregated results
      const entityInsights = await this.extractEntities(aggregatedResults, query);

      // Step 5: Build relationship chains
      const relationshipChains = await this.buildRelationshipChains(
        entityInsights,
        aggregatedResults,
        { userId, orgId }
      );

      // Step 6: Extract semantic facts
      const semanticFacts = this.extractSemanticFacts(aggregatedResults, entityInsights);

      // Step 7: Generate synthesis (if enabled)
      let synthesis = null;
      if (includeAnalysis) {
        synthesis = await this.generateSynthesis(query, aggregatedResults, {
          entityInsights,
          relationshipChains,
          semanticFacts
        });
      }

      const duration = Date.now() - startTime;

      logger.info('InsightForge analysis completed', {
        requestId,
        durationMs: duration,
        subQueryCount: subQueries.length,
        totalResults: aggregatedResults.length,
        entityCount: entityInsights.length,
        chainCount: relationshipChains.length
      });

      return {
        query,
        subQueries,
        results: aggregatedResults.slice(0, this.config.subQueries.maxCount * 3),
        semanticFacts,
        entityInsights,
        relationshipChains,
        synthesis,
        metadata: {
          requestId,
          durationMs: duration,
          subQueryCount: subQueries.length,
          totalRawResults: subQueryResults.reduce((sum, r) => sum + r.results.length, 0),
          uniqueResults: aggregatedResults.length,
          entityCount: entityInsights.length,
          chainCount: relationshipChains.length,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      logger.error('InsightForge analysis failed', {
        requestId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  // ==========================================
  // Sub-Query Generation
  // ==========================================

  /**
   * Generate sub-queries using LLM
   *
   * @private
   * @param {string} query - Original query
   * @param {Object} options - Generation options
   * @param {string} [options.simulationRequirement] - Additional context
   * @param {number} [options.limit=5] - Maximum sub-queries
   * @returns {Promise<Array>} Generated sub-queries
   */
  async generateSubQueries(query, options = {}) {
    const { simulationRequirement, limit = this.config.subQueries.defaultCount } = options;

    const prompt = this.buildSubQueryPrompt(query, simulationRequirement);

    try {
      const response = await this.llmClient.generate(prompt, {
        model: this.config.llm.model,
        temperature: this.config.llm.subQueryTemperature,
        maxTokens: this.config.llm.maxTokens
      });

      const parsed = this.parseLLMJson(response);

      if (!parsed.subQueries || !Array.isArray(parsed.subQueries)) {
        logger.warn('Invalid sub-query response format, using fallback', {
          response: response.slice(0, 200)
        });
        return this.generateFallbackSubQueries(query, limit);
      }

      // Validate and normalize sub-queries
      const subQueries = parsed.subQueries
        .slice(0, limit)
        .map((sq, index) => ({
          id: `sq-${index + 1}`,
          query: sq.query || sq.subQuery || query,
          focus: sq.focus || 'general',
          weight: Math.max(0.1, Math.min(1.0, sq.weight || 0.2)),
          reasoning: parsed.reasoning || ''
        }));

      // Normalize weights to sum to 1.0
      const totalWeight = subQueries.reduce((sum, sq) => sum + sq.weight, 0);
      subQueries.forEach(sq => {
        sq.weight = sq.weight / totalWeight;
      });

      logger.debug('Generated sub-queries', {
        count: subQueries.length,
        focuses: subQueries.map(sq => sq.focus)
      });

      return subQueries;
    } catch (error) {
      logger.error('Sub-query generation failed, using fallback', {
        error: error.message
      });
      return this.generateFallbackSubQueries(query, limit);
    }
  }

  /**
   * Build prompt for sub-query generation
   *
   * @private
   * @param {string} query - Original query
   * @param {string} [simulationRequirement] - Additional context
   * @returns {string} Formatted prompt
   */
  buildSubQueryPrompt(query, simulationRequirement) {
    let prompt = `${SUBQUERY_SYSTEM_PROMPT}\n\nOriginal Query: "${query}"`;

    if (simulationRequirement) {
      prompt += `\n\nAdditional Context: ${simulationRequirement}`;
    }

    prompt += `\n\nGenerate ${this.config.subQueries.defaultCount} sub-queries as JSON:`;

    return prompt;
  }

  /**
   * Generate fallback sub-queries when LLM fails
   *
   * @private
   * @param {string} query - Original query
   * @param {number} limit - Maximum sub-queries
   * @returns {Array} Fallback sub-queries
   */
  generateFallbackSubQueries(query, limit) {
    const queryLower = query.toLowerCase();
    const subQueries = [
      { id: 'sq-1', query, focus: 'direct', weight: 0.4 }
    ];

    // Add temporal variations
    if (!queryLower.includes('recent')) {
      subQueries.push({
        id: 'sq-2',
        query: `recent ${query}`,
        focus: 'temporal_recent',
        weight: 0.2
      });
    }

    if (!queryLower.includes('history')) {
      subQueries.push({
        id: 'sq-3',
        query: `history of ${query}`,
        focus: 'temporal_historical',
        weight: 0.2
      });
    }

    // Add entity-focused variation
    subQueries.push({
      id: 'sq-4',
      query: `who is involved in ${query}`,
      focus: 'entities',
      weight: 0.1
    });

    // Add relationship variation
    subQueries.push({
      id: 'sq-5',
      query: `what relates to ${query}`,
      focus: 'relationships',
      weight: 0.1
    });

    return subQueries.slice(0, limit);
  }

  // ==========================================
  // Sub-Query Search
  // ==========================================

  /**
   * Execute searches for all sub-queries
   *
   * @private
   * @param {Array} subQueries - Sub-queries to search
   * @param {Object} options - Search options
   * @param {string} options.userId - User ID
   * @param {string} options.orgId - Organization ID
   * @param {number} options.limit - Results per sub-query
   * @returns {Promise<Array>} Results for each sub-query
   */
  async searchSubQueries(subQueries, options) {
    const { userId, orgId, project, limit } = options;

    const searchPromises = subQueries.map(async (subQuery) => {
      const startTime = Date.now();

      try {
        const results = await hybridSearch.hybridSearch({
          query: subQuery.query,
          userId,
          orgId,
          project,
          limit,
          weights: {
            vector: 0.6,
            keyword: 0.3,
            graph: 0.1
          }
        });

        return {
          subQuery,
          results: results.results || [],
          durationMs: Date.now() - startTime,
          success: true
        };
      } catch (error) {
        logger.error('Sub-query search failed', {
          subQuery: subQuery.query,
          error: error.message
        });

        return {
          subQuery,
          results: [],
          durationMs: Date.now() - startTime,
          success: false,
          error: error.message
        };
      }
    });

    return Promise.all(searchPromises);
  }

  // ==========================================
  // Result Aggregation
  // ==========================================

  /**
   * Aggregate and deduplicate results from multiple sub-queries
   *
   * @private
   * @param {Array} subQueryResults - Results from each sub-query
   * @returns {Array} Aggregated unique results
   */
  aggregateResults(subQueryResults) {
    const resultMap = new Map();

    for (const { subQuery, results } of subQueryResults) {
      for (const result of results) {
        const id = result.id || result.memory?.id;
        if (!id) continue;

        const existing = resultMap.get(id);
        if (existing) {
          // Boost score for results found in multiple sub-queries
          existing.score += result.score * subQuery.weight;
          existing.matchCount += 1;
          existing.subQueries.push(subQuery.id);
          existing.sources.add(subQuery.focus);
        } else {
          resultMap.set(id, {
            ...result,
            originalScore: result.score,
            score: result.score * subQuery.weight,
            matchCount: 1,
            subQueries: [subQuery.id],
            sources: new Set([subQuery.focus])
          });
        }
      }
    }

    // Convert to array and apply multi-match boost
    const aggregated = Array.from(resultMap.values()).map(result => {
      const multiMatchBoost = Math.min(
        (result.matchCount - 1) * this.config.aggregation.boostForMultipleMatches,
        0.3
      );
      result.score += multiMatchBoost;
      result.sources = Array.from(result.sources);
      return result;
    });

    // Sort by score descending
    aggregated.sort((a, b) => b.score - a.score);

    // Filter by minimum score
    return aggregated.filter(r => r.score >= this.config.aggregation.minResultScore);
  }

  // ==========================================
  // Entity Extraction
  // ==========================================

  /**
   * Extract entities from aggregated results using LLM
   *
   * @private
   * @param {Array} results - Aggregated search results
   * @param {string} query - Original query
   * @returns {Promise<Array>} Extracted entities with insights
   */
  async extractEntities(results, query) {
    if (results.length === 0) {
      return [];
    }

    // Prepare context for entity extraction
    const context = results
      .slice(0, 10)
      .map(r => r.content || r.memory?.content || '')
      .filter(Boolean)
      .join('\n\n---\n\n');

    const prompt = `${ENTITY_EXTRACTION_PROMPT}\n\nQuery: "${query}"\n\nMemories:\n${context}\n\nExtract entities as JSON:`;

    try {
      const response = await this.llmClient.generate(prompt, {
        model: this.config.llm.model,
        temperature: 0.3,
        maxTokens: this.config.llm.maxTokens
      });

      const parsed = this.parseLLMJson(response);

      if (!parsed.entities || !Array.isArray(parsed.entities)) {
        logger.warn('Invalid entity extraction response, using fallback');
        return this.extractEntitiesFallback(results);
      }

      // Filter by confidence and limit
      return parsed.entities
        .filter(e => (e.confidence || 0) >= this.config.entities.minConfidence)
        .slice(0, this.config.entities.maxEntities)
        .map(entity => ({
          ...entity,
          id: `entity-${this.hashString(entity.name)}`,
          extractedAt: new Date().toISOString()
        }));
    } catch (error) {
      logger.error('Entity extraction failed, using fallback', {
        error: error.message
      });
      return this.extractEntitiesFallback(results);
    }
  }

  /**
   * Fallback entity extraction using simple heuristics
   *
   * @private
   * @param {Array} results - Search results
   * @returns {Array} Basic entity extraction
   */
  extractEntitiesFallback(results) {
    const entityMap = new Map();

    // Simple pattern-based extraction
    const patterns = [
      { regex: /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, type: 'person' },
      { regex: /\b[A-Z][A-Z]+\b/g, type: 'organization' },
      { regex: /\b[A-Z][a-z]+ (?:Inc|Corp|Ltd|LLC|Company)\b/g, type: 'organization' }
    ];

    for (const result of results) {
      const content = result.content || result.memory?.content || '';

      for (const { regex, type } of patterns) {
        const matches = content.match(regex) || [];
        for (const match of matches) {
          const key = match.toLowerCase();
          if (entityMap.has(key)) {
            entityMap.get(key).mentions += 1;
          } else {
            entityMap.set(key, {
              id: `entity-${this.hashString(match)}`,
              name: match,
              type,
              confidence: 0.6,
              mentions: 1,
              attributes: {},
              relatedEntities: [],
              extractedAt: new Date().toISOString()
            });
          }
        }
      }
    }

    return Array.from(entityMap.values())
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, this.config.entities.maxEntities);
  }

  // ==========================================
  // Relationship Chain Building
  // ==========================================

  /**
   * Build relationship chains between entities
   *
   * @private
   * @param {Array} entities - Extracted entities
   * @param {Array} results - Search results
   * @param {Object} options - Options
   * @param {string} options.userId - User ID
   * @param {string} options.orgId - Organization ID
   * @returns {Promise<Array>} Relationship chains
   */
  async buildRelationshipChains(entities, results, options) {
    const { userId, orgId } = options;

    if (!this.graphStore || entities.length < 2) {
      return this.buildSimpleChains(entities, results);
    }

    try {
      const chains = [];
      const entityNames = new Set(entities.map(e => e.name.toLowerCase()));

      // Find connections through graph traversal
      for (const result of results.slice(0, 10)) {
        const memoryId = result.id || result.memory?.id;
        if (!memoryId) continue;

        // Get related memories through graph
        const related = await this.graphStore.getRelatedMemories(memoryId, {
          maxDepth: this.config.chains.maxDepth,
          minConfidence: this.config.chains.minConfidence
        });

        for (const rel of related || []) {
          const fromEntity = this.findEntityForMemory(rel.from_id, results, entities);
          const toEntity = this.findEntityForMemory(rel.to_id, results, entities);
          const fromNode = (fromEntity && toEntity && fromEntity.id === toEntity.id)
            ? await this.createMemoryAnchor(rel.from_id, results)
            : (fromEntity || await this.createMemoryAnchor(rel.from_id, results));
          const toNode = (fromEntity && toEntity && fromEntity.id === toEntity.id)
            ? await this.createMemoryAnchor(rel.to_id, results)
            : (toEntity || await this.createMemoryAnchor(rel.to_id, results));

          if (fromNode && toNode && fromNode.id !== toNode.id) {
            chains.push({
              id: `chain-${chains.length + 1}`,
              from: fromNode,
              to: toNode,
              relationship: rel.type,
              confidence: rel.confidence || 0.5,
              path: [fromNode.name, rel.type, toNode.name],
              evidence: rel.metadata || {}
            });
          }
        }
      }

      // Deduplicate and sort by confidence
      const uniqueChains = this.deduplicateChains(chains);
      uniqueChains.sort((a, b) => b.confidence - a.confidence);

      return uniqueChains.slice(0, this.config.chains.maxChains);
    } catch (error) {
      logger.error('Relationship chain building failed, using simple chains', {
        error: error.message
      });
      return this.buildSimpleChains(entities, results);
    }
  }

  /**
   * Build simple chains without graph store
   *
   * @private
   * @param {Array} entities - Extracted entities
   * @param {Array} results - Search results
   * @returns {Array} Simple relationship chains
   */
  buildSimpleChains(entities, results) {
    const chains = [];

    // Create co-occurrence chains
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const entity1 = entities[i];
        const entity2 = entities[j];

        // Check if they appear together in any result
        const cooccurrence = results.some(r => {
          const content = (r.content || r.memory?.content || '').toLowerCase();
          return content.includes(entity1.name.toLowerCase()) &&
                 content.includes(entity2.name.toLowerCase());
        });

        if (cooccurrence) {
          chains.push({
            id: `chain-${chains.length + 1}`,
            from: entity1,
            to: entity2,
            relationship: 'co-occurs_with',
            confidence: 0.5,
            path: [entity1.name, 'mentioned together', entity2.name],
            evidence: { cooccurrence: true }
          });
        }
      }
    }

    return chains.slice(0, this.config.chains.maxChains);
  }

  /**
   * Find entity associated with a memory
   *
   * @private
   * @param {string} memoryId - Memory ID
   * @param {Array} results - Search results
   * @param {Array} entities - Extracted entities
   * @returns {Object|null} Associated entity
   */
  findEntityForMemory(memoryId, results, entities) {
    const result = results.find(r => (r.id || r.memory?.id) === memoryId);
    if (!result) return null;

    const content = (result.content || result.memory?.content || '').toLowerCase();
    const title = (result.title || result.memory?.title || '').toLowerCase();
    const tagText = Array.isArray(result.tags || result.memory?.tags)
      ? (result.tags || result.memory?.tags).join(' ').toLowerCase()
      : '';
    const haystack = `${title}\n${content}\n${tagText}`;

    for (const entity of entities) {
      if (haystack.includes(entity.name.toLowerCase())) {
        return entity;
      }
    }

    return null;
  }

  async createMemoryAnchor(memoryId, results) {
    const result = results.find(r => (r.id || r.memory?.id) === memoryId);
    let memory = result?.memory || null;

    if ((!memory || !memory.title) && this.graphStore?.getMemory) {
      memory = await this.graphStore.getMemory(memoryId);
    }

    if (!result && !memory) return null;

    const title = result?.title || result?.memory?.title || memory?.title;
    const content = result?.content || result?.memory?.content || memory?.content || '';
    const label = title || content.slice(0, 80) || memoryId;

    return {
      id: `memory-${memoryId}`,
      name: label,
      memoryId,
      title: title || null,
      displayLabel: `${label} (${memoryId})`,
      type: 'memory',
      confidence: result?.score || 0.5,
      extractedAt: new Date().toISOString()
    };
  }

  /**
   * Deduplicate relationship chains
   *
   * @private
   * @param {Array} chains - Relationship chains
   * @returns {Array} Deduplicated chains
   */
  deduplicateChains(chains) {
    const seen = new Set();
    const unique = [];

    for (const chain of chains) {
      const key = `${chain.from.id}-${chain.to.id}-${chain.relationship}`;
      const reverseKey = `${chain.to.id}-${chain.from.id}-${chain.relationship}`;

      if (!seen.has(key) && !seen.has(reverseKey)) {
        seen.add(key);
        unique.push(chain);
      }
    }

    return unique;
  }

  // ==========================================
  // Semantic Fact Extraction
  // ==========================================

  /**
   * Extract semantic facts from results
   *
   * @private
   * @param {Array} results - Search results
   * @param {Array} entities - Extracted entities
   * @returns {Array} Semantic facts
   */
  extractSemanticFacts(results, entities) {
    const facts = [];

    for (const result of results.slice(0, 15)) {
      const content = result.content || result.memory?.content || '';
      const memoryId = result.id || result.memory?.id;

      // Extract declarative statements
      const sentences = content
        .split(/[.!?]+/)
        .map(s => s.trim())
        .filter(s => s.length > 20 && s.length < 200);

      for (const sentence of sentences) {
        // Check if sentence contains entities
        const containsEntity = entities.some(e =>
          sentence.toLowerCase().includes(e.name.toLowerCase())
        );

        if (containsEntity) {
          facts.push({
            fact: sentence,
            confidence: result.score * 0.8,
            supportingMemories: [memoryId],
            category: 'fact',
            extractedAt: new Date().toISOString()
          });
        }
      }
    }

    // Sort by confidence and deduplicate
    facts.sort((a, b) => b.confidence - a.confidence);
    return this.deduplicateFacts(facts).slice(0, 20);
  }

  /**
   * Deduplicate semantic facts
   *
   * @private
   * @param {Array} facts - Semantic facts
   * @returns {Array} Deduplicated facts
   */
  deduplicateFacts(facts) {
    const unique = [];
    const seen = new Set();

    for (const fact of facts) {
      const normalized = fact.fact.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        unique.push(fact);
      }
    }

    return unique;
  }

  // ==========================================
  // Synthesis Generation
  // ==========================================

  /**
   * Generate synthesis using LLM
   *
   * @private
   * @param {string} query - Original query
   * @param {Array} results - Search results
   * @param {Object} context - Analysis context
   * @returns {Promise<Object>} Synthesis results
   */
  async generateSynthesis(query, results, context) {
    const { entityInsights, relationshipChains, semanticFacts } = context;

    // Prepare summary of findings
    const findingsSummary = {
      resultCount: results.length,
      topResults: results.slice(0, 5).map(r => ({
        content: (r.content || r.memory?.content || '').slice(0, 200),
        score: r.score
      })),
      keyEntities: entityInsights.slice(0, 5).map(e => e.name),
      keyRelationships: relationshipChains.slice(0, 5).map(c => ({
        from: c.from.name,
        to: c.to.name,
        type: c.relationship
      })),
      factCount: semanticFacts.length
    };

    const prompt = `${ANALYSIS_PROMPT}\n\nQuery: "${query}"\n\nFindings Summary:\n${JSON.stringify(findingsSummary, null, 2)}\n\nGenerate analysis as JSON:`;

    try {
      const response = await this.llmClient.generate(prompt, {
        model: this.config.llm.model,
        temperature: 0.4,
        maxTokens: this.config.llm.maxTokens
      });

      return this.parseLLMJson(response);
    } catch (error) {
      logger.error('Synthesis generation failed', { error: error.message });
      return {
        semanticFacts: semanticFacts.slice(0, 5),
        patterns: [],
        insights: [],
        gaps: ['Unable to generate full synthesis']
      };
    }
  }

  // ==========================================
  // Utility Methods
  // ==========================================

  /**
   * Parse JSON from LLM response
   *
   * @private
   * @param {string} response - LLM response
   * @returns {Object} Parsed JSON
   */
  parseLLMJson(response) {
    try {
      // Try direct parsing first
      return JSON.parse(response);
    } catch {
      // Try extracting JSON from markdown code blocks
      const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        try {
          return JSON.parse(codeBlockMatch[1].trim());
        } catch {
          // Continue to next attempt
        }
      }

      // Try finding JSON object in text
      const objectMatch = response.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        try {
          return JSON.parse(objectMatch[0]);
        } catch {
          // Continue to fallback
        }
      }

      logger.warn('Failed to parse LLM response as JSON', { response: response.slice(0, 200) });
      return {};
    }
  }

  /**
   * Simple hash function for generating IDs
   *
   * @private
   * @param {string} str - String to hash
   * @returns {string} Hash string
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36).slice(0, 8);
  }
}

// ==========================================
// Export
// ==========================================

export default {
  InsightForge,
  CONFIG,
  SUBQUERY_SYSTEM_PROMPT,
  ENTITY_EXTRACTION_PROMPT,
  ANALYSIS_PROMPT
};

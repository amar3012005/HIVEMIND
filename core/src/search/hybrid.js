/**
 * Hybrid Search Module
 *
 * Combines vector search, keyword search, and graph traversal
 * Implements multi-modal recall for comprehensive memory retrieval
 *
 * @module search/hybrid
 */

import { getMistralEmbedService } from '../embeddings/mistral.js';
import { getQdrantClient } from '../vector/qdrant-client.js';
import ranker from '../recall/ranker.js';
const { rank, rankHybrid } = ranker;
import scorer from '../recall/scorer.js';
const { getVectorComponent, getRecencyComponent, getImportanceComponent, getEbbinghausComponent } = scorer;
import { getPrismaClient } from '../db/prisma.js';
import { Prisma } from '@prisma/client';

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // Search weights
  weights: {
    vector: 0.6,
    keyword: 0.3,
    graph: 0.1
  },

  // Search limits
  limits: {
    vectorTopK: 50,
    keywordTopK: 50,
    graphTopK: 20,
    finalLimit: 20
  },

  // Graph traversal configuration
  graph: {
    maxDepth: 3,
    minConfidence: 0.5,
    relationshipTypes: ['Updates', 'Extends', 'Derives']
  },

  // Fallback configuration
  fallback: {
    enableKeywordFallback: true,
    enableGraphFallback: true,
    vectorMinScore: parseFloat(process.env.HIVEMIND_VECTOR_SCORE_THRESHOLD || '0.15'),
    finalMinScore: parseFloat(process.env.HIVEMIND_FINAL_HYBRID_SCORE_THRESHOLD || '0.10')
  },

  // Temporal search configuration
  temporal: {
    defaultIncludeExpired: false,
    defaultIncludeHistorical: false,
    expiredStatusField: 'temporal_status',
    historicalVersionField: 'is_latest'
  }
};

const DEFAULT_COLLECTION = process.env.QDRANT_COLLECTION || 'BUNDB AGENT';
let embedService = null;

// ==========================================
// Logger
// ==========================================

const logger = {
  info: (msg, ctx) => console.log(`[HYBRID SEARCH INFO] ${msg}`, ctx || {}),
  warn: (msg, ctx) => console.warn(`[HYBRID SEARCH WARN] ${msg}`, ctx || {}),
  error: (msg, ctx) => console.error(`[HYBRID SEARCH ERROR] ${msg}`, ctx || {}),
  debug: (msg, ctx) => console.debug(`[HYBRID SEARCH DEBUG] ${msg}`, ctx || {})
};

// ==========================================
// Vector Search
// ==========================================

/**
 * Perform vector search using Qdrant
 *
 * @param {number[]} queryVector - Query embedding vector
 * @param {object} options - Search options
 * @param {string} options.collection - Collection name
 * @param {number} options.limit - Maximum results
 * @param {string} options.userId - User ID (required)
 * @param {string} options.orgId - Organization ID
 * @param {string} options.memoryType - Memory type filter
 * @param {string[]} options.tags - Tags filter
 * @param {string} options.sourcePlatform - Source platform filter
 * @param {boolean} options.isLatest - Latest version filter
 * @param {boolean} options.includeExpired - Include expired content
 * @param {boolean} options.includeHistorical - Include historical versions
 * @param {object} options.dateRange - Date range filter
 * @param {number} options.minStrength - Minimum strength
 * @param {number} options.minImportance - Minimum importance
 * @param {number} options.scoreThreshold - Minimum score threshold
 * @returns {Array} Vector search results
 */
async function vectorSearch(queryVector, options = {}) {
  const {
    collection = DEFAULT_COLLECTION,
    limit = CONFIG.limits.vectorTopK,
    scoreThreshold = CONFIG.fallback.vectorMinScore,
    // Filter options
    userId,
    orgId,
    memoryType,
    tags,
    sourcePlatform,
    isLatest,
    includeExpired = CONFIG.temporal.defaultIncludeExpired,
    includeHistorical = CONFIG.temporal.defaultIncludeHistorical,
    dateRange,
    minStrength,
    minImportance,
    ...additionalFilters
  } = options;

  try {
    // Build filter from all options
    const filter = {
      userId,
      orgId,
      memoryType,
      tags,
      sourcePlatform,
      isLatest,
      includeExpired,
      includeHistorical,
      dateRange,
      minStrength,
      minImportance,
      ...additionalFilters
    };

    const qdrantFilter = buildQdrantFilter(filter);

    // Perform search
    const results = await getQdrantClient().searchMemories({
      vector: queryVector,
      collectionName: collection,
      filter: qdrantFilter,
      limit,
      score_threshold: scoreThreshold,
      with_payload: true
    });

    // Transform results
    return results.map(result => ({
      id: result.id,
      score: result.score,
      payload: result.payload,
      source: 'vector'
    }));
  } catch (error) {
    logger.error('Vector search failed', {
      error: error.message,
      limit,
      scoreThreshold
    });
    return [];
  }
}

async function semanticSearch(query, options = {}) {
  const {
    collection = DEFAULT_COLLECTION,
    limit = CONFIG.limits.vectorTopK,
    scoreThreshold = CONFIG.fallback.vectorMinScore,
    userId,
    orgId,
    memoryType,
    tags,
    sourcePlatform,
    isLatest,
    includeExpired = CONFIG.temporal.defaultIncludeExpired,
    includeHistorical = CONFIG.temporal.defaultIncludeHistorical,
    dateRange,
    minStrength,
    minImportance,
    ...additionalFilters
  } = options;

  const qdrantFilter = buildQdrantFilter({
    userId,
    orgId,
    memoryType,
    tags,
    sourcePlatform,
    isLatest,
    includeExpired,
    includeHistorical,
    dateRange,
    minStrength,
    minImportance,
    ...additionalFilters
  });

  const results = await getQdrantClient().searchMemories({
    query,
    collectionName: collection,
    filter: qdrantFilter,
    limit,
    score_threshold: scoreThreshold
  });

  return results.map(result => ({
    id: result.id,
    score: result.score,
    payload: result.payload,
    source: 'vector'
  }));
}

async function resolveQueryVector(query, existingVector) {
  if (Array.isArray(existingVector) && existingVector.length > 0) {
    return existingVector;
  }

  if (!query || typeof query !== 'string') {
    return null;
  }

  try {
    embedService ||= getMistralEmbedService();
    if (!embedService) {
      logger.warn('Embedding service unavailable for semantic search');
      return null;
    }

    return await embedService.embedOne(query);
  } catch (error) {
    logger.warn('Failed to generate query embedding for hybrid search', {
      error: error.message
    });
    return null;
  }
}

function mergeSemanticResults(...resultSets) {
  const merged = new Map();

  for (const results of resultSets) {
    for (const result of results) {
      const existing = merged.get(result.id);
      if (!existing || result.score > existing.score) {
        merged.set(result.id, {
          ...existing,
          ...result,
          source: 'vector'
        });
      }
    }
  }

  return Array.from(merged.values());
}

/**
 * Build Qdrant filter from search options
 *
 * @param {object} filter - Filter object
 * @returns {object} Qdrant filter
 */
function buildQdrantFilter(filter) {
  const must = [];
  const mustNot = [];

  // User ID filter (tenant isolation)
  if (filter.userId) {
    must.push({
      key: 'user_id',
      match: {
        value: filter.userId
      }
    });
  }

  // Organization ID filter
  if (filter.orgId) {
    must.push({
      key: 'org_id',
      match: {
        value: filter.orgId
      }
    });
  }

  // Memory type filter
  if (filter.memoryType) {
    must.push({
      key: 'memory_type',
      match: {
        value: filter.memoryType
      }
    });
  }

  // Tags filter
  if (filter.tags && filter.tags.length > 0) {
    must.push({
      key: 'tags',
      match: {
        any: filter.tags
      }
    });
  }

  // Source platform filter
  if (filter.sourcePlatform) {
    must.push({
      key: 'source_platform',
      match: {
        value: filter.sourcePlatform
      }
    });
  }

  // Is latest filter
  if (filter.isLatest !== undefined) {
    must.push({
      key: 'is_latest',
      match: {
        value: filter.isLatest
      }
    });
  }

  // Visibility filter
  if (filter.visibility) {
    must.push({
      key: 'visibility',
      match: {
        value: filter.visibility
      }
    });
  }

  // Strength filter
  if (filter.minStrength !== undefined) {
    must.push({
      key: 'strength',
      range: {
        gte: filter.minStrength
      }
    });
  }

  // Temporal status filter - exclude expired content unless explicitly included
  if (filter.includeExpired === false) {
    mustNot.push({
      key: CONFIG.temporal.expiredStatusField,
      match: {
        value: 'expired'
      }
    });
  }

  // Historical versions filter - exclude historical (non-latest) versions unless explicitly included
  if (filter.includeHistorical === false && filter.isLatest === undefined) {
    must.push({
      key: CONFIG.temporal.historicalVersionField,
      match: {
        value: true
      }
    });
  }

  // Date range filter
  if (filter.dateRange) {
    const dateFilter = { key: 'document_date' };

    if (filter.dateRange.start) {
      dateFilter.range = { ...dateFilter.range, gte: filter.dateRange.start };
    }
    if (filter.dateRange.end) {
      dateFilter.range = { ...dateFilter.range, lte: filter.dateRange.end };
    }

    if (dateFilter.range) {
      must.push(dateFilter);
    }
  }

  // Importance score filter
  if (filter.minImportance !== undefined) {
    must.push({
      key: 'importance_score',
      range: {
        gte: filter.minImportance
      }
    });
  }

  const result = { must };
  if (mustNot.length > 0) {
    result.must_not = mustNot;
  }

  return result;
}

// ==========================================
// Keyword Search
// ==========================================

/**
 * Perform keyword search using PostgreSQL full-text search
 *
 * @param {string} query - Search query
 * @param {object} options - Search options
 * @param {string} options.userId - User ID (required for multi-tenant isolation)
 * @param {string} options.orgId - Organization ID
 * @param {number} options.limit - Maximum results
 * @param {number} options.minScore - Minimum score threshold
 * @returns {Array} Keyword search results
 */
async function keywordSearch(query, options = {}) {
  const {
    userId,
    orgId,
    limit = CONFIG.limits.keywordTopK,
    minScore = 0.2
  } = options;

  // Validate required parameters
  if (!userId) {
    logger.error('Keyword search failed: userId is required for multi-tenant isolation');
    return [];
  }

  if (!query || query.trim().length === 0) {
    logger.warn('Keyword search called with empty query');
    return [];
  }

  try {
    const prisma = getPrismaClient();

    if (!prisma) {
      logger.error('Keyword search failed: Prisma client not available');
      return [];
    }

    // Execute PostgreSQL full-text search with parameterized queries
    // Using Prisma's $queryRaw with template literals for SQL injection protection
    const results = await prisma.$queryRaw`
      SELECT 
        m.id, 
        m.content, 
        m.metadata, 
        m.created_at, 
        m.updated_at,
        ts_rank_cd(
          to_tsvector('english', m.content), 
          plainto_tsquery('english', ${query})
        ) as score
      FROM memories m
      WHERE m.user_id = ${userId}
        AND m.deleted_at IS NULL
        AND to_tsvector('english', m.content) @@ plainto_tsquery('english', ${query})
      ORDER BY score DESC
      LIMIT ${limit}
    `;

    // Transform results to expected format
    const formattedResults = results.map(result => ({
      id: result.id,
      content: result.content,
      score: parseFloat(result.score),
      metadata: result.metadata || {},
      created_at: result.created_at,
      updated_at: result.updated_at,
      source: 'keyword'
    }));

    // Filter by minimum score threshold
    const filteredResults = formattedResults.filter(
      result => result.score >= minScore
    );

    logger.info('Keyword search completed successfully', {
      query,
      userId,
      totalResults: results.length,
      filteredResults: filteredResults.length,
      limit
    });

    return filteredResults;
  } catch (error) {
    logger.error('Keyword search failed', {
      error: error.message,
      query: query ? query.substring(0, 100) : null,
      userId,
      limit
    });
    return [];
  }
}

// ==========================================
// Graph Search
// ==========================================

/**
 * Parse Apache AGE agtype value to JavaScript object
 * AGE returns agtype as JSON-like strings that need parsing
 *
 * @param {any} value - Raw agtype value from AGE
 * @returns {any} Parsed JavaScript value
 */
function parseAgtype(value) {
  if (value === null || value === undefined) {
    return null;
  }

  // If it's already a primitive type, return as-is
  if (typeof value !== 'string') {
    return value;
  }

  // Try to parse as JSON (AGE agtype is JSON-compatible)
  try {
    // Handle AGE vertex/edge format: {"id": ..., "label": ..., "properties": {...}}
    const parsed = JSON.parse(value);
    return parsed;
  } catch (e) {
    // If not valid JSON, return the string value
    return value;
  }
}

/**
 * Extract properties from AGE vertex/edge object
 *
 * @param {object} agtypeObj - Parsed agtype object
 * @returns {object} Extracted properties
 */
function extractAgtypeProperties(agtypeObj) {
  if (!agtypeObj || typeof agtypeObj !== 'object') {
    return {};
  }

  // AGE vertex format: {id, label, properties}
  if (agtypeObj.properties) {
    return agtypeObj.properties;
  }

  // AGE edge format: {id, label, start_id, end_id, properties}
  if (agtypeObj.properties) {
    return agtypeObj.properties;
  }

  // Direct properties object
  return agtypeObj;
}

/**
 * Build relationship type filter for Cypher query
 *
 * @param {string[]} relationshipTypes - Array of relationship types
 * @returns {string} Cypher relationship type filter string
 */
function buildRelationshipTypeFilter(relationshipTypes) {
  if (!relationshipTypes || relationshipTypes.length === 0) {
    return '';
  }

  // Format: :UPDATES|EXTENDS|DERIVES
  const types = relationshipTypes
    .map(type => type.toUpperCase())
    .join('|');

  return `:[${types}]`;
}

/**
 * Perform graph traversal search using Apache AGE
 *
 * Traverses the memory graph from a starting memory ID, following
 * relationships (Updates, Extends, Derives) to find connected memories.
 *
 * @param {string} memoryId - Starting memory ID (UUID)
 * @param {object} options - Search options
 * @param {number} options.maxDepth - Maximum traversal depth (default: 3)
 * @param {number} options.minConfidence - Minimum relationship confidence (default: 0.5)
 * @param {string[]} options.relationshipTypes - Relationship types to follow (default: ['Updates', 'Extends', 'Derives'])
 * @param {string} options.userId - User ID for multi-tenant isolation (required)
 * @param {string} options.orgId - Organization ID for additional isolation
 * @param {number} options.limit - Maximum results to return (default: 20)
 * @returns {Array} Graph search results with relationship information
 */
async function graphSearch(memoryId, options = {}) {
  const {
    maxDepth = CONFIG.graph.maxDepth,
    minConfidence = CONFIG.graph.minConfidence,
    relationshipTypes = CONFIG.graph.relationshipTypes,
    userId,
    orgId,
    limit = CONFIG.limits.graphTopK
  } = options;

  // Validate required parameters
  if (!memoryId) {
    logger.warn('Graph search called without memoryId');
    return [];
  }

  if (!userId) {
    logger.error('Graph search failed: userId is required for multi-tenant isolation');
    return [];
  }

  // Validate UUID format for security (prevent injection)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(memoryId)) {
    logger.error('Graph search failed: Invalid memoryId format', { memoryId });
    throw new Error('Invalid memoryId format: must be a valid UUID');
  }
  if (!uuidRegex.test(userId)) {
    logger.error('Graph search failed: Invalid userId format', { userId });
    throw new Error('Invalid userId format: must be a valid UUID');
  }
  if (orgId && !uuidRegex.test(orgId)) {
    logger.error('Graph search failed: Invalid orgId format', { orgId });
    throw new Error('Invalid orgId format: must be a valid UUID');
  }

  // Validate maxDepth (prevent excessive traversal)
  const validatedMaxDepth = Math.min(Math.max(1, maxDepth), 5);
  if (validatedMaxDepth !== maxDepth) {
    logger.warn('Graph search maxDepth clamped', {
      requested: maxDepth,
      clamped: validatedMaxDepth
    });
  }

  // Validate minConfidence (must be between 0 and 1)
  const validatedMinConfidence = Math.min(Math.max(0, minConfidence), 1);
  if (validatedMinConfidence !== minConfidence) {
    logger.warn('Graph search minConfidence clamped', {
      requested: minConfidence,
      clamped: validatedMinConfidence
    });
  }

  try {
    const prisma = getPrismaClient();

    if (!prisma) {
      logger.error('Graph search failed: Prisma client not available');
      return [];
    }

    // Build relationship type filter (safe - uses predefined relationship types)
    const relTypeFilter = buildRelationshipTypeFilter(relationshipTypes);

    // Execute Apache AGE Cypher query using parameterized queries
    // Note: AGE Cypher doesn't support standard SQL parameterization inside the cypher() function
    // We use Prisma's $queryRaw with template literals for SQL-safe parameterization
    // The Cypher-specific parts use validated/sanitized inputs only
    const results = await prisma.$queryRaw`
      SELECT * FROM cypher('hivemind_memory_graph', $$
        MATCH (m:Memory {id: ${memoryId}})-[r${Prisma.raw(relTypeFilter)}*1..${Prisma.raw(String(validatedMaxDepth))}]-(n:Memory)
        WHERE ALL(rel IN r WHERE rel.confidence >= ${validatedMinConfidence})
          AND n.user_id = ${userId}
          ${orgId ? Prisma.raw(`AND n.org_id = '${orgId}'`) : Prisma.raw('')}
          AND n.id != ${memoryId}
        RETURN
          n.id as id,
          n.content as content,
          n.metadata as metadata,
          n.created_at as created_at,
          n.updated_at as updated_at,
          n.memory_type as memory_type,
          n.source_platform as source_platform,
          n.importance_score as importance_score,
          n.strength as strength,
          length(r) as depth,
          [rel IN r | rel.type] as relationship_types,
          [rel IN r | rel.confidence] as confidences,
          r[0].type as first_relationship_type,
          r[0].confidence as first_confidence
        LIMIT ${limit}
      $$) AS (
        id agtype,
        content agtype,
        metadata agtype,
        created_at agtype,
        updated_at agtype,
        memory_type agtype,
        source_platform agtype,
        importance_score agtype,
        strength agtype,
        depth agtype,
        relationship_types agtype,
        confidences agtype,
        first_relationship_type agtype,
        first_confidence agtype
      )
    `;

    if (!results || results.length === 0) {
      logger.info('Graph search returned no results', { memoryId, userId });
      return [];
    }

    // Transform AGE agtype results to standard format
    const formattedResults = results.map(row => {
      // Parse agtype values
      const id = parseAgtype(row.id);
      const content = parseAgtype(row.content);
      const metadata = parseAgtype(row.metadata) || {};
      const createdAt = parseAgtype(row.created_at);
      const updatedAt = parseAgtype(row.updated_at);
      const memoryType = parseAgtype(row.memory_type);
      const sourcePlatform = parseAgtype(row.source_platform);
      const importanceScore = parseFloat(parseAgtype(row.importance_score)) || 0;
      const strength = parseFloat(parseAgtype(row.strength)) || 0;
      const depth = parseInt(parseAgtype(row.depth)) || 1;

      // Parse relationship information
      const relationshipTypes = parseAgtype(row.relationship_types) || [];
      const confidences = parseAgtype(row.confidences) || [];
      const firstRelType = parseAgtype(row.first_relationship_type) || 'Unknown';
      const firstConfidence = parseFloat(parseAgtype(row.first_confidence)) || minConfidence;

      // Calculate average confidence across the path
      const avgConfidence = confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : firstConfidence;

      // Build result object
      return {
        id: id?.toString() || '',
        content: content?.toString() || '',
        metadata: {
          ...metadata,
          memory_type: memoryType,
          source_platform: sourcePlatform,
          importance_score: importanceScore,
          strength: strength,
          created_at: createdAt,
          updated_at: updatedAt
        },
        relationship_type: firstRelType,
        confidence: avgConfidence,
        depth: depth,
        source: 'graph',
        score: avgConfidence * (1 / depth), // Score decays with depth
        // Additional graph-specific metadata
        graph_metadata: {
          path_depth: depth,
          relationship_chain: relationshipTypes,
          confidence_chain: confidences,
          starting_memory_id: memoryId
        }
      };
    });

    // Filter out any results that failed to parse
    const validResults = formattedResults.filter(r => r.id && r.id !== '');

    // Remove duplicates (same memory reached via different paths)
    const uniqueResults = new Map();
    validResults.forEach(result => {
      const existing = uniqueResults.get(result.id);
      if (!existing || result.depth < existing.depth) {
        // Keep the shortest path to each memory
        uniqueResults.set(result.id, result);
      }
    });

    const finalResults = Array.from(uniqueResults.values());

    logger.info('Graph search completed successfully', {
      memoryId,
      userId,
      totalResults: results.length,
      uniqueResults: finalResults.length,
      maxDepth: validatedMaxDepth,
      minConfidence: validatedMinConfidence
    });

    return finalResults;

  } catch (error) {
    // Log detailed error but don't expose internal details
    logger.error('Graph search failed', {
      error: error.message,
      memoryId,
      userId,
      maxDepth: validatedMaxDepth,
      minConfidence: validatedMinConfidence,
      // Include stack trace only in debug mode
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });

    // Graceful fallback: return empty array
    return [];
  }
}

// ==========================================
// Hybrid Search
// ==========================================

/**
 * Perform hybrid search combining all search methods
 *
 * @param {object} options - Search options
 * @param {string} options.query - Search query text
 * @param {number[]} options.queryVector - Pre-computed query embedding
 * @param {string} options.userId - User ID (required for multi-tenant isolation)
 * @param {string} options.orgId - Organization ID
 * @param {string} options.memoryType - Filter by memory type
 * @param {string[]} options.tags - Filter by tags
 * @param {string} options.sourcePlatform - Filter by source platform
 * @param {boolean} options.isLatest - Filter to latest versions only
 * @param {boolean} options.includeExpired - Include expired content (default: false)
 * @param {boolean} options.includeHistorical - Include historical versions (default: false)
 * @param {object} options.dateRange - Date range filter {start, end}
 * @param {number} options.minStrength - Minimum memory strength
 * @param {number} options.minImportance - Minimum importance score
 * @param {number} options.limit - Maximum results
 * @param {object} options.weights - Search weights {vector, keyword, graph}
 * @param {string} options.depth - Search depth ('shallow', 'medium', 'full')
 * @param {object} options.filter - Additional filter object
 * @returns {object} Hybrid search results
 */
async function hybridSearch(options = {}) {
  const {
    query,
    queryVector: providedQueryVector,
    userId,
    orgId,
    memoryType,
    tags,
    sourcePlatform,
    isLatest = true,
    includeExpired = CONFIG.temporal.defaultIncludeExpired,
    includeHistorical = CONFIG.temporal.defaultIncludeHistorical,
    dateRange,
    minStrength,
    minImportance,
    limit = CONFIG.limits.finalLimit,
    weights = CONFIG.weights,
    depth = 'medium',
    filter: additionalFilter = {}
  } = options;

  const startTime = Date.now();

  logger.info('Starting hybrid search', {
    query,
    userId,
    limit,
    weights
  });

  // Validate required parameters
  if (!userId) {
    throw new Error('userId is required for multi-tenant isolation');
  }

  const queryVector = await resolveQueryVector(query, providedQueryVector);

  // Step 1: Vector search
  let vectorResults = [];
  let directVectorResults = [];
  if (queryVector) {
    directVectorResults = await vectorSearch(queryVector, {
      userId,
      orgId,
      memoryType,
      tags,
      sourcePlatform,
      isLatest,
      includeExpired,
      includeHistorical,
      dateRange,
      minStrength,
      minImportance,
      limit: CONFIG.limits.vectorTopK,
      ...additionalFilter
    });
  }

  let semanticFallbackResults = [];
  if (query) {
    semanticFallbackResults = await semanticSearch(query, {
      userId,
      orgId,
      memoryType,
      tags,
      sourcePlatform,
      isLatest,
      includeExpired,
      includeHistorical,
      dateRange,
      minStrength,
      minImportance,
      limit: CONFIG.limits.vectorTopK,
      ...additionalFilter
    });
  }

  vectorResults = mergeSemanticResults(directVectorResults, semanticFallbackResults);

  // Step 2: Keyword search (if query provided)
  let keywordResults = [];
  if (query) {
    keywordResults = await keywordSearch(query, {
      userId,
      orgId,
      limit: CONFIG.limits.keywordTopK
    });
  }

  // Step 3: Graph search (if starting memory provided)
  let graphResults = [];
  if (options.startMemoryId) {
    graphResults = await graphSearch(options.startMemoryId, {
      maxDepth: CONFIG.graph.maxDepth,
      minConfidence: CONFIG.graph.minConfidence,
      userId,
      orgId
    });
  }

  // Step 4: Combine and rank results
  const combinedResults = combineSearchResults(
    vectorResults,
    keywordResults,
    graphResults,
    weights
  );

  // Step 5: Rank results
  const rankedResults = rank(combinedResults, {
    strategy: 'hybrid',
    recencyBias: 0.7
  });

  // Step 6: Apply minimum score threshold
  const filteredResults = rankedResults.filter(
    r => r.score >= CONFIG.fallback.finalMinScore
  );

  // Step 7: Limit results
  const finalResults = filteredResults.slice(0, limit);

  const duration = Date.now() - startTime;

  logger.info('Hybrid search completed', {
    durationMs: duration,
    vectorResults: vectorResults.length,
    keywordResults: keywordResults.length,
    graphResults: graphResults.length,
    finalResults: finalResults.length
  });

  return {
    results: finalResults,
    metadata: {
      vectorCount: vectorResults.length,
      keywordCount: keywordResults.length,
      graphCount: graphResults.length,
      finalCount: finalResults.length,
      durationMs: duration,
      timestamp: new Date().toISOString(),
      temporal: {
        includeExpired,
        includeHistorical,
        dateRange
      },
      depth
    }
  };
}

/**
 * Combine results from different search methods
 *
 * @param {Array} vectorResults - Vector search results
 * @param {Array} keywordResults - Keyword search results
 * @param {Array} graphResults - Graph search results
 * @param {object} weights - Search weights
 * @returns {Array} Combined results
 */
function combineSearchResults(vectorResults, keywordResults, graphResults, weights) {
  const combined = new Map();

  // Add vector results
  vectorResults.forEach(result => {
    combined.set(result.id, {
      ...result,
      similarity_score: result.score,
      vectorScore: result.score,
      keywordScore: 0,
      graphScore: 0
    });
  });

  // Add keyword results
  keywordResults.forEach(result => {
    const existing = combined.get(result.id);
    if (existing) {
      existing.keywordScore = result.score;
    } else {
      combined.set(result.id, {
        ...result,
        similarity_score: 0,
        vectorScore: 0,
        keywordScore: result.score,
        graphScore: 0
      });
    }
  });

  // Add graph results
  graphResults.forEach(result => {
    const existing = combined.get(result.id);
    if (existing) {
      existing.graphScore = result.score;
    } else {
      combined.set(result.id, {
        ...result,
        similarity_score: 0,
        vectorScore: 0,
        keywordScore: 0,
        graphScore: result.score
      });
    }
  });

  // Calculate combined scores
  return Array.from(combined.values()).map(result => {
    const combinedScore =
      result.vectorScore * weights.vector +
      result.keywordScore * weights.keyword +
      result.graphScore * weights.graph;

    return {
      ...result,
      similarity_score: result.vectorScore,
      score: combinedScore,
      breakdown: {
        vector: result.vectorScore * weights.vector,
        keyword: result.keywordScore * weights.keyword,
        graph: result.graphScore * weights.graph
      }
    };
  });
}

// ==========================================
// Fallback Search
// ==========================================

/**
 * Perform fallback search when primary search returns no results
 *
 * @param {object} options - Search options
 * @param {string} options.query - Search query
 * @param {string} options.userId - User ID (required)
 * @param {string} options.orgId - Organization ID
 * @param {string} options.memoryType - Memory type filter
 * @param {string[]} options.tags - Tags filter
 * @param {string} options.sourcePlatform - Source platform filter
 * @param {boolean} options.isLatest - Latest version filter
 * @param {boolean} options.includeExpired - Include expired content
 * @param {boolean} options.includeHistorical - Include historical versions
 * @param {number} options.minStrength - Minimum strength
 * @param {number} options.limit - Maximum results
 * @returns {Array} Fallback results
 */
async function fallbackSearch(options = {}) {
  const {
    query,
    userId,
    orgId,
    memoryType,
    tags,
    sourcePlatform,
    isLatest = true,
    includeExpired = CONFIG.temporal.defaultIncludeExpired,
    includeHistorical = CONFIG.temporal.defaultIncludeHistorical,
    minStrength,
    limit = CONFIG.limits.finalLimit
  } = options;

  logger.info('Starting fallback search', {
    query,
    userId,
    limit
  });

  // Try keyword search first
  if (query) {
    const keywordResults = await keywordSearch(query, {
      userId,
      orgId,
      limit
    });

    if (keywordResults.length > 0) {
      return keywordResults;
    }
  }

  // Try vector search without query
  const vectorResults = await vectorSearch(
    new Array(1024).fill(0), // Placeholder vector
    {
      userId,
      orgId,
      memoryType,
      tags,
      sourcePlatform,
      isLatest,
      includeExpired,
      includeHistorical,
      minStrength,
      limit
    }
  );

  if (vectorResults.length > 0) {
    return vectorResults;
  }

  // Return empty results
  return [];
}

// ==========================================
// Export
// ==========================================

export default {
  // Main search functions
  hybridSearch,
  vectorSearch,
  keywordSearch,
  graphSearch,
  fallbackSearch,

  // Utilities
  combineSearchResults,
  buildQdrantFilter,

  // Configuration
  CONFIG
};

// Additional exports for temporal filtering
export {
  buildQdrantFilter,
  combineSearchResults
};

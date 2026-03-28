/**
 * Three-Tier Retrieval Architecture
 *
 * Implements MiroFish-inspired three-tier search system:
 * - Tier 1: QuickSearch - Fast semantic search for immediate results
 * - Tier 2: PanoramaSearch - Comprehensive search including historical/expired content
 * - Tier 3: InsightForge - Deep multi-dimensional analysis with sub-query generation
 *
 * @module search/three-tier-retrieval
 * @requires search/hybrid
 * @requires search/panorama-search
 * @requires search/insight-forge
 * @requires vector/collections
 * @requires recall/ranker
 * @requires recall/scorer
 */

import { getQdrantCollections } from '../vector/collections.js';
import ranker from '../recall/ranker.js';
const { rank, formatResults } = ranker;
import scorer from '../recall/scorer.js';
const { scoreAndRank, adjustWeightsForQuery } = scorer;
import hybridSearch from './hybrid.js';
import { PanoramaSearch } from './panorama-search.js';
import { InsightForge } from './insight-forge.js';

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // Tier-specific limits
  limits: {
    quickSearch: 10,
    panoramaSearch: 50,
    insightForge: 30
  },

  // Score thresholds
  thresholds: {
    quickSearch: parseFloat(process.env.HIVEMIND_VECTOR_SCORE_THRESHOLD || '0.15'),
    panoramaSearch: 0.2,
    insightForge: 0.25
  },

  // Search depth
  depth: {
    shallow: 1,
    medium: 2,
    full: 3
  },

  // Temporal status categories
  temporalStatus: {
    active: 'active',
    expired: 'expired',
    historical: 'historical',
    archived: 'archived'
  },

  // Default weights for each tier
  weights: {
    quickSearch: {
      vector: 0.7,
      keyword: 0.2,
      graph: 0.1
    },
    panoramaSearch: {
      vector: 0.5,
      keyword: 0.3,
      graph: 0.2
    },
    insightForge: {
      vector: 0.4,
      keyword: 0.2,
      graph: 0.3,
      insight: 0.1
    }
  }
};

// ==========================================
// Logger
// ==========================================

const logger = {
  info: (msg, ctx) => console.log(`[THREE-TIER INFO] ${msg}`, ctx || {}),
  warn: (msg, ctx) => console.warn(`[THREE-TIER WARN] ${msg}`, ctx || {}),
  error: (msg, ctx) => console.error(`[THREE-TIER ERROR] ${msg}`, ctx || {}),
  debug: (msg, ctx) => console.debug(`[THREE-TIER DEBUG] ${msg}`, ctx || {})
};

function matchesScope(result, { userId, orgId, project } = {}) {
  const payload = result?.payload || result?.memory || {};
  const actualUserId = result?.user_id || payload.user_id || null;
  const actualOrgId = result?.org_id || payload.org_id || null;
  const actualProject = result?.project || payload.project || null;

  return (userId == null || actualUserId == null || actualUserId === userId)
    && (orgId == null || actualOrgId == null || actualOrgId === orgId)
    && (project == null || actualProject == null || actualProject === project);
}

function filterScopedResults(results, scope) {
  if (!Array.isArray(results)) {
    return [];
  }
  return results.filter((result) => matchesScope(result, scope));
}

// ==========================================
// ThreeTierRetrieval Class
// ==========================================

/**
 * Three-Tier Retrieval System
 *
 * Provides three levels of search depth:
 * 1. QuickSearch: Fast results for immediate needs
 * 2. PanoramaSearch: Comprehensive historical view
 * 3. InsightForge: Deep analysis with LLM-powered insights
 */
export class ThreeTierRetrieval {
  /**
   * Create a ThreeTierRetrieval instance
   *
   * @param {Object} options - Configuration options
   * @param {Object} options.vectorStore - Vector store instance (Qdrant)
   * @param {Object} options.graphStore - Graph store instance (Prisma/AGE)
   * @param {Object} options.llmClient - LLM client for InsightForge (Groq)
   * @param {Object} options.config - Optional configuration overrides
   */
  constructor(options = {}) {
    this.vectorStore = options.vectorStore || getQdrantCollections();
    this.graphStore = options.graphStore;
    this.llmClient = options.llmClient;
    this.config = { ...CONFIG, ...(options.config || {}) };

    // Initialize sub-modules
    this.panoramaSearchEngine = new PanoramaSearch({
      vectorStore: this.vectorStore,
      graphStore: this.graphStore,
      config: this.config
    });

    this.insightForgeEngine = new InsightForge({
      vectorStore: this.vectorStore,
      graphStore: this.graphStore,
      llmClient: this.llmClient,
      config: this.config
    });

    logger.info('ThreeTierRetrieval initialized', {
      hasVectorStore: !!this.vectorStore,
      hasGraphStore: !!this.graphStore,
      hasLLMClient: !!this.llmClient
    });
  }

  // ==========================================
  // Tier 1: QuickSearch
  // ==========================================

  /**
   * QuickSearch - Fast semantic search for immediate results
   *
   * Features:
   * - Direct vector + keyword search
   * - Limit: 10 results
   * - Exclude expired content
   * - Depth: shallow
   * - Optimized for speed (<100ms target)
   *
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @param {string} options.userId - User ID (required for multi-tenant isolation)
   * @param {string} options.orgId - Organization ID
   * @param {string} [options.memoryType] - Filter by memory type
   * @param {string[]} [options.tags] - Filter by tags
   * @param {string} [options.sourcePlatform] - Filter by source platform
   * @param {number} [options.limit=10] - Maximum results
   * @param {number} [options.scoreThreshold=0.3] - Minimum score threshold
   * @returns {Promise<Object>} QuickSearch results
   */
  async quickSearch(query, options = {}) {
    const startTime = Date.now();
    const requestId = crypto.randomUUID();

    const {
      userId,
      orgId,
      project,
      memoryType,
      tags,
      sourcePlatform,
      limit = this.config.limits.quickSearch,
      scoreThreshold = this.config.thresholds.quickSearch
    } = options;

    logger.info('Starting QuickSearch', {
      requestId,
      query,
      userId,
      limit
    });

    // Validate required parameters
    if (!userId) {
      throw new Error('userId is required for multi-tenant isolation');
    }

    try {
      // Perform hybrid search with shallow depth
      const results = await hybridSearch.hybridSearch({
        query,
        userId,
        orgId,
        project,
        isLatest: true,
        memoryType,
        tags,
        sourcePlatform,
        limit,
        includeExpired: false,
        includeHistorical: false,
        weights: this.config.weights.quickSearch,
        depth: this.config.depth.shallow
      });

      // Apply score threshold, but don't discard all lexical/hybrid matches.
      const filteredResults = results.results.filter(
        r => r.score >= scoreThreshold
      );
      const fallbackApplied = filteredResults.length === 0 && results.results.length > 0;
      const candidateResults = fallbackApplied
        ? results.results.slice(0, limit)
        : filteredResults;

      // Rank with recency bias for quick results
      const rankedResults = rank(candidateResults, {
        strategy: 'hybrid',
        recencyBias: 0.7
      });

      const duration = Date.now() - startTime;

      logger.info('QuickSearch completed', {
        requestId,
        durationMs: duration,
        resultCount: rankedResults.length,
        totalFound: results.results.length
      });

      return {
        tier: 'quick',
        query,
        results: rankedResults.slice(0, limit),
        metadata: {
          requestId,
          durationMs: duration,
          totalFound: results.results.length,
          returnedCount: Math.min(rankedResults.length, limit),
          scoreThreshold,
          fallbackApplied,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      logger.error('QuickSearch failed', {
        requestId,
        error: error.message,
        query,
        userId
      });
      throw error;
    }
  }

  // ==========================================
  // Tier 2: PanoramaSearch
  // ==========================================

  /**
   * PanoramaSearch - Comprehensive search including historical/expired content
   *
   * Features:
   * - Include expired and historical content
   * - Limit: 50 results
   * - Depth: full
   * - Categorize by temporal status
   * - Timeline view of results
   *
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @param {string} options.userId - User ID (required)
   * @param {string} options.orgId - Organization ID
   * @param {boolean} [options.includeExpired=true] - Include expired content
   * @param {boolean} [options.includeHistorical=true] - Include historical versions
   * @param {string} [options.dateRange] - Filter by date range
   * @param {number} [options.limit=50] - Maximum results
   * @returns {Promise<Object>} PanoramaSearch results
   */
  async panoramaSearch(query, options = {}) {
    const startTime = Date.now();
    const requestId = crypto.randomUUID();

    const {
      userId,
      orgId,
      project,
      includeExpired = true,
      includeHistorical = true,
      dateRange,
      limit = this.config.limits.panoramaSearch
    } = options;

    logger.info('Starting PanoramaSearch', {
      requestId,
      query,
      userId,
      includeExpired,
      includeHistorical
    });

    if (!userId) {
      throw new Error('userId is required for multi-tenant isolation');
    }

    try {
      // Delegate to PanoramaSearch module
      const results = await this.panoramaSearchEngine.search(query, {
        userId,
        orgId,
        project,
        includeExpired,
        includeHistorical,
        dateRange,
        limit,
        weights: this.config.weights.panoramaSearch
      });

      if ((results.results || []).length === 0) {
        const quickFallback = await this.quickSearch(query, {
          userId,
          orgId,
          project,
          limit
        });

        if ((quickFallback.results || []).length > 0) {
          return {
            tier: 'panorama',
            query,
            results: quickFallback.results,
            categories: {
              active: quickFallback.results,
              expired: [],
              historical: [],
              archived: []
            },
            timeline: null,
            statistics: {
              fallbackTier: 'quick',
              returnedCount: quickFallback.results.length
            },
            metadata: {
              requestId,
              durationMs: Date.now() - startTime,
              timestamp: new Date().toISOString(),
              fallbackTier: 'quick'
            }
          };
        }
      }

      const duration = Date.now() - startTime;

      logger.info('PanoramaSearch completed', {
        requestId,
        durationMs: duration,
        resultCount: results.results.length,
        categories: Object.keys(results.categories || {})
      });

      return {
        tier: 'panorama',
        query,
        ...results,
        metadata: {
          requestId,
          durationMs: duration,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      logger.error('PanoramaSearch failed', {
        requestId,
        error: error.message,
        query,
        userId
      });
      throw error;
    }
  }

  // ==========================================
  // Tier 3: InsightForge
  // ==========================================

  /**
   * InsightForge - Deep multi-dimensional analysis
   *
   * Features:
   * - Generate sub-queries using LLM
   * - Search for each sub-query
   * - Extract entities and build relationship chains
   * - Return semantic facts, entity insights, relationship chains
   * - Multi-dimensional result aggregation
   *
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @param {string} options.userId - User ID (required)
   * @param {string} options.orgId - Organization ID
   * @param {string} [options.simulationRequirement] - Additional context for sub-query generation
   * @param {number} [options.subQueryLimit=5] - Maximum sub-queries to generate
   * @param {number} [options.resultsPerSubQuery=15] - Results per sub-query
   * @param {boolean} [options.includeAnalysis=true] - Include LLM analysis
   * @returns {Promise<Object>} InsightForge results
   */
  async insightForge(query, options = {}) {
    const startTime = Date.now();
    const requestId = crypto.randomUUID();

    const {
      userId,
      orgId,
      project,
      simulationRequirement,
      subQueryLimit = 5,
      resultsPerSubQuery = 15,
      includeAnalysis = true
    } = options;

    logger.info('Starting InsightForge', {
      requestId,
      query,
      userId,
      hasSimulationRequirement: !!simulationRequirement
    });

    if (!userId) {
      throw new Error('userId is required for multi-tenant isolation');
    }

    if (!this.llmClient) {
      throw new Error('LLM client is required for InsightForge');
    }

    try {
      // Delegate to InsightForge module
      const results = await this.insightForgeEngine.analyze(query, {
        userId,
        orgId,
        project,
        simulationRequirement,
        subQueryLimit,
        resultsPerSubQuery,
        includeAnalysis,
        weights: this.config.weights.insightForge
      });
      const scopedResults = filterScopedResults(results.results, { userId, orgId, project });

      const duration = Date.now() - startTime;

      logger.info('InsightForge completed', {
        requestId,
        durationMs: duration,
        subQueryCount: results.subQueries?.length || 0,
        entityCount: results.entityInsights?.length || 0,
        chainCount: results.relationshipChains?.length || 0
      });

      return {
        tier: 'insight',
        query,
        ...results,
        results: scopedResults,
        metadata: {
          requestId,
          durationMs: duration,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      logger.error('InsightForge failed', {
        requestId,
        error: error.message,
        query,
        userId
      });
      throw error;
    }
  }

  // ==========================================
  // Unified Search Interface
  // ==========================================

  /**
   * Unified search interface - automatically selects appropriate tier
   *
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @param {string} options.tier - Tier to use: 'quick', 'panorama', 'insight', or 'auto'
   * @param {string} options.userId - User ID (required)
   * @param {string} options.orgId - Organization ID
   * @returns {Promise<Object>} Search results from selected tier
   */
  async search(query, options = {}) {
    const { tier = 'auto', ...tierOptions } = options;

    // Auto-select tier based on query characteristics
    if (tier === 'auto') {
      const selectedTier = this.selectTier(query, tierOptions);
      return this.executeTierSearch(selectedTier, query, tierOptions);
    }

    return this.executeTierSearch(tier, query, tierOptions);
  }

  /**
   * Select appropriate tier based on query characteristics
   *
   * @private
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {string} Selected tier: 'quick', 'panorama', or 'insight'
   */
  selectTier(query, options = {}) {
    const queryLower = query.toLowerCase();

    // InsightForge indicators (complex analysis)
    const insightIndicators = [
      'analyze', 'why', 'how did', 'what caused', 'relationship between',
      'connect', 'pattern', 'trend', 'insight', 'deep dive',
      'comprehensive', 'thorough', 'investigate', 'explore'
    ];

    // Panorama indicators (historical view)
    const panoramaIndicators = [
      'history', 'past', 'previous', 'evolution', 'timeline',
      'archive', 'all versions', 'over time', 'changes'
    ];

    // Check for explicit tier requests
    if (options.requireInsight || options.simulationRequirement) {
      return 'insight';
    }

    if (options.includeHistorical || options.includeExpired) {
      return 'panorama';
    }

    // Analyze query content
    if (insightIndicators.some(indicator => queryLower.includes(indicator))) {
      return 'insight';
    }

    if (panoramaIndicators.some(indicator => queryLower.includes(indicator))) {
      return 'panorama';
    }

    // Default to quick for simple queries
    return 'quick';
  }

  /**
   * Execute search for specific tier
   *
   * @private
   * @param {string} tier - Tier to execute
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Promise<Object>} Search results
   */
  async executeTierSearch(tier, query, options) {
    switch (tier) {
      case 'quick':
        return this.quickSearch(query, options);
      case 'panorama':
        return this.panoramaSearch(query, options);
      case 'insight':
        return this.insightForge(query, options);
      default:
        throw new Error(`Unknown tier: ${tier}`);
    }
  }

  // ==========================================
  // Utility Methods
  // ==========================================

  /**
   * Compare results across all three tiers
   *
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Promise<Object>} Comparison of all tiers
   */
  async compareTiers(query, options = {}) {
    const startTime = Date.now();
    const requestId = crypto.randomUUID();

    logger.info('Starting tier comparison', { requestId, query });

    const results = {
      requestId,
      query,
      tiers: {}
    };

    // Run all three tiers in parallel
    const [quick, panorama, insight] = await Promise.allSettled([
      this.quickSearch(query, options),
      this.panoramaSearch(query, options),
      this.llmClient ? this.insightForge(query, options) : Promise.resolve(null)
    ]);

    // Collect results
    if (quick.status === 'fulfilled') {
      results.tiers.quick = {
        success: true,
        durationMs: quick.value.metadata.durationMs,
        resultCount: quick.value.results.length,
        topScore: quick.value.results[0]?.score || 0
      };
    } else {
      results.tiers.quick = { success: false, error: quick.reason?.message };
    }

    if (panorama.status === 'fulfilled') {
      results.tiers.panorama = {
        success: true,
        durationMs: panorama.value.metadata.durationMs,
        resultCount: panorama.value.results.length,
        categories: Object.keys(panorama.value.categories || {})
      };
    } else {
      results.tiers.panorama = { success: false, error: panorama.reason?.message };
    }

    if (insight) {
      if (insight.status === 'fulfilled' && insight.value) {
        results.tiers.insight = {
          success: true,
          durationMs: insight.value.metadata.durationMs,
          subQueryCount: insight.value.subQueries?.length || 0,
          entityCount: insight.value.entityInsights?.length || 0
        };
      } else {
        results.tiers.insight = {
          success: false,
          error: insight.reason?.message || 'LLM client not available'
        };
      }
    }

    results.totalDurationMs = Date.now() - startTime;
    results.timestamp = new Date().toISOString();

    return results;
  }
}

// ==========================================
// Convenience Functions
// ==========================================

/**
 * Create ThreeTierRetrieval instance with default configuration
 *
 * @param {Object} options - Configuration options
 * @returns {ThreeTierRetrieval} Configured instance
 */
export function createThreeTierRetrieval(options = {}) {
  return new ThreeTierRetrieval(options);
}

/**
 * Quick search convenience function
 *
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @returns {Promise<Object>} QuickSearch results
 */
export async function quickSearch(query, options = {}) {
  const retrieval = new ThreeTierRetrieval(options);
  return retrieval.quickSearch(query, options);
}

/**
 * Panorama search convenience function
 *
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @returns {Promise<Object>} PanoramaSearch results
 */
export async function panoramaSearch(query, options = {}) {
  const retrieval = new ThreeTierRetrieval(options);
  return retrieval.panoramaSearch(query, options);
}

/**
 * InsightForge convenience function
 *
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @returns {Promise<Object>} InsightForge results
 */
export async function insightForgeSearch(query, options = {}) {
  const retrieval = new ThreeTierRetrieval(options);
  return retrieval.insightForge(query, options);
}

// ==========================================
// Export
// ==========================================

export default {
  ThreeTierRetrieval,
  createThreeTierRetrieval,
  quickSearch,
  panoramaSearch,
  insightForgeSearch,
  CONFIG
};

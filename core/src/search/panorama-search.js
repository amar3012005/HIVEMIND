/**
 * PanoramaSearch - Historical Content Retrieval
 *
 * Comprehensive search including expired and historical content.
 * Categorizes results by temporal status and provides timeline views.
 *
 * @module search/panorama-search
 * @requires search/hybrid
 * @requires recall/ranker
 * @requires recall/scorer
 */

import hybridSearch from './hybrid.js';
import ranker from '../recall/ranker.js';
const { rank, formatResults } = ranker;
import scorer from '../recall/scorer.js';
const { scoreAndRank, getRecencyComponent } = scorer;
import { getPrismaClient } from '../db/prisma.js';

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // Search limits
  limits: {
    default: 50,
    max: 100,
    min: 10
  },

  // Score thresholds
  thresholds: {
    active: 0.3,
    expired: 0.25,
    historical: 0.2,
    archived: 0.15
  },

  // Temporal categories
  categories: {
    active: 'active',
    expired: 'expired',
    historical: 'historical',
    archived: 'archived'
  },

  // Date ranges for temporal classification
  dateRanges: {
    recent: 30,      // days
    medium: 90,      // days
    old: 365,        // days
    historical: 730  // days (2 years)
  },

  // Search weights
  weights: {
    vector: 0.5,
    keyword: 0.3,
    graph: 0.2
  }
};

// ==========================================
// Logger
// ==========================================

const logger = {
  info: (msg, ctx) => console.log(`[PANORAMA INFO] ${msg}`, ctx || {}),
  warn: (msg, ctx) => console.warn(`[PANORAMA WARN] ${msg}`, ctx || {}),
  error: (msg, ctx) => console.error(`[PANORAMA ERROR] ${msg}`, ctx || {}),
  debug: (msg, ctx) => console.debug(`[PANORAMA DEBUG] ${msg}`, ctx || {})
};

function isScopedPanoramaResult(result, { userId, orgId, project }) {
  const payload = result?.payload || result?.memory || result || {};
  const payloadUserId = payload.user_id || payload.userId || null;
  const payloadOrgId = payload.org_id || payload.orgId || null;
  const payloadProject = payload.project || null;

  if (userId && payloadUserId && payloadUserId !== userId) return false;
  if (orgId && payloadOrgId && payloadOrgId !== orgId) return false;
  if (project && payloadProject !== project) return false;
  return true;
}

function lexicalProjectScore(query = '', text = '') {
  const queryTokens = String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(token => token.length >= 3);
  const haystack = String(text).toLowerCase();
  if (queryTokens.length === 0 || !haystack) return 0;
  const matched = queryTokens.filter(token => haystack.includes(token));
  return matched.length / queryTokens.length;
}

// ==========================================
// PanoramaSearch Class
// ==========================================

/**
 * PanoramaSearch - Comprehensive Historical Search
 *
 * Features:
 * - Include expired and historical content
 * - Categorize by temporal status (active, expired, historical, archived)
 * - Timeline view of results
 * - Full-depth graph traversal
 * - Temporal filtering and sorting
 */
export class PanoramaSearch {
  /**
   * Create a PanoramaSearch instance
   *
   * @param {Object} options - Configuration options
   * @param {Object} options.vectorStore - Vector store instance
   * @param {Object} options.graphStore - Graph store instance
   * @param {Object} options.config - Optional configuration overrides
   */
  constructor(options = {}) {
    this.vectorStore = options.vectorStore;
    this.graphStore = options.graphStore;
    this.config = { ...CONFIG, ...(options.config || {}) };

    logger.info('PanoramaSearch initialized');
  }

  // ==========================================
  // Main Search Method
  // ==========================================

  /**
   * Perform comprehensive panorama search
   *
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @param {string} options.userId - User ID (required for multi-tenant isolation)
   * @param {string} options.orgId - Organization ID
   * @param {boolean} [options.includeExpired=true] - Include expired content
   * @param {boolean} [options.includeHistorical=true] - Include historical versions
   * @param {Object} [options.dateRange] - Date range filter {start, end}
   * @param {string} [options.temporalStatus] - Filter by specific temporal status
   * @param {number} [options.limit=50] - Maximum results
   * @param {boolean} [options.includeTimeline=true] - Include timeline view
   * @param {Object} [options.weights] - Search weights
   * @returns {Promise<Object>} Panorama search results
   */
  async search(query, options = {}) {
    const startTime = Date.now();
    const requestId = crypto.randomUUID();

    const {
      userId,
      orgId,
      project,
      includeExpired = true,
      includeHistorical = true,
      dateRange,
      temporalStatus,
      limit = this.config.limits.default,
      includeTimeline = true,
      weights = this.config.weights
    } = options;

    logger.info('Starting PanoramaSearch', {
      requestId,
      query,
      userId,
      includeExpired,
      includeHistorical,
      limit
    });

    // Validate required parameters
    if (!userId) {
      throw new Error('userId is required for multi-tenant isolation');
    }

    try {
      // Step 1: Perform hybrid search with temporal filters
      const searchResults = await this.executeTemporalSearch(query, {
        userId,
        orgId,
        project,
        includeExpired,
        includeHistorical,
        dateRange,
        limit: Math.min(limit * 2, this.config.limits.max),
        weights
      });

      // Step 2: Categorize results by temporal status
      const categorized = this.categorizeByTemporalStatus(searchResults.results);

      // Step 3: Apply temporal status filter if specified
      let filteredResults = searchResults.results;
      if (temporalStatus) {
        filteredResults = categorized[temporalStatus] || [];
      }

      // Step 4: Rank results with temporal awareness
      const rankedResults = this.rankWithTemporalAwareness(filteredResults);

      // Step 5: Build timeline if requested
      const timeline = includeTimeline ? this.buildTimeline(rankedResults) : null;

      // Step 6: Calculate statistics
      const stats = this.calculateStatistics(categorized, rankedResults);

      const duration = Date.now() - startTime;

      logger.info('PanoramaSearch completed', {
        requestId,
        durationMs: duration,
        totalResults: rankedResults.length,
        categories: Object.keys(categorized).filter(k => categorized[k].length > 0)
      });

      return {
        query,
        results: rankedResults.slice(0, limit),
        categories: {
          active: categorized.active.slice(0, limit),
          expired: categorized.expired.slice(0, limit),
          historical: categorized.historical.slice(0, limit),
          archived: categorized.archived.slice(0, limit)
        },
        timeline,
        statistics: stats,
        metadata: {
          requestId,
          durationMs: duration,
          totalFound: searchResults.results.length,
          returnedCount: Math.min(rankedResults.length, limit),
          includeExpired,
          includeHistorical,
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
  // Temporal Search Execution
  // ==========================================

  /**
   * Execute search with temporal filters
   *
   * @private
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Promise<Object>} Search results
   */
  async executeTemporalSearch(query, options) {
    const {
      userId,
      orgId,
      project,
      includeExpired,
      includeHistorical,
      dateRange,
      limit,
      weights
    } = options;

    // Build temporal filter for Qdrant
    const temporalFilter = this.buildTemporalFilter({
      includeExpired,
      includeHistorical,
      dateRange,
      project
    });

    const enforceScope = (items = []) => items.filter(result => isScopedPanoramaResult(result, {
      userId,
      orgId,
      project
    }));

    // Perform hybrid search
    let results = await hybridSearch.hybridSearch({
      query,
      userId,
      orgId,
      project,
      isLatest: includeHistorical ? undefined : true,
      limit,
      includeExpired,
      includeHistorical,
      vectorScoreThreshold: 0.12,
      finalScoreThreshold: 0.05,
      filter: temporalFilter,
      weights,
      depth: 'full'
    });

    results = {
      ...results,
      results: enforceScope(results.results || [])
    };

    if ((results.results || []).length === 0) {
      const fallbackResults = await hybridSearch.hybridSearch({
        query,
        userId,
        orgId,
        project,
        isLatest: includeHistorical ? undefined : true,
        limit,
        includeExpired,
        includeHistorical,
        dateRange,
        vectorScoreThreshold: 0,
        finalScoreThreshold: 0,
        weights: {
          vector: 0.7,
          keyword: 0.2,
          graph: 0.1
        },
        depth: 'full'
      });

      results = {
        ...fallbackResults,
        results: enforceScope(fallbackResults.results || [])
      };
    }

    if ((results.results || []).length === 0) {
      results = {
        results: await this.fallbackProjectSearch(query, {
          userId,
          orgId,
          project,
          includeHistorical,
          dateRange,
          limit
        }),
        metadata: {
          fallback: 'project_memory_scan'
        }
      };
    }

    // If graph store is available, enhance with graph traversal
    if (this.graphStore) {
      const enhancedResults = await this.enhanceWithGraph(results.results, {
        userId,
        orgId,
        project,
        includeExpired
      });
      return { ...results, results: enhancedResults };
    }

    return results;
  }

  async fallbackProjectSearch(query, options) {
    const {
      userId,
      orgId,
      project,
      includeHistorical,
      dateRange,
      limit
    } = options;

    const prisma = getPrismaClient();
    if (!prisma) {
      return [];
    }

    const where = {
      user_id: userId,
      deleted_at: null
    };
    if (orgId) where.org_id = orgId;
    if (project) where.project = project;
    if (!includeHistorical) where.is_latest = true;
    if (dateRange?.start || dateRange?.end) {
      where.document_date = {};
      if (dateRange.start) where.document_date.gte = new Date(dateRange.start);
      if (dateRange.end) where.document_date.lte = new Date(dateRange.end);
    }

    const memories = await prisma.memory.findMany({
      where,
      orderBy: [
        { document_date: 'desc' },
        { created_at: 'desc' }
      ],
      take: Math.max(limit * 3, 20)
    });

    return memories
      .map(memory => ({
        ...memory,
        score: lexicalProjectScore(query, `${memory.title || ''} ${memory.content || ''}`),
        source: 'panorama_fallback'
      }))
      .filter(result => result.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  /**
   * Build temporal filter for search
   *
   * @private
   * @param {Object} options - Filter options
   * @returns {Object} Temporal filter
   */
  buildTemporalFilter(options) {
    const { includeExpired, includeHistorical, dateRange, project } = options;
    const must = [];

    // Add temporal status filters
    if (!includeExpired && !includeHistorical) {
      // Only active content
      must.push({
        key: 'temporal_status',
        match: { value: 'active' }
      });
    }

    // Add date range filter if specified
    if (dateRange) {
      const rangeFilter = { key: 'document_date' };

      if (dateRange.start) {
        rangeFilter.range = { ...rangeFilter.range, gte: dateRange.start };
      }
      if (dateRange.end) {
        rangeFilter.range = { ...rangeFilter.range, lte: dateRange.end };
      }

      must.push(rangeFilter);
    }

    if (project) {
      must.push({
        key: 'project',
        match: { value: project }
      });
    }

    return { must };
  }

  /**
   * Enhance results with graph traversal
   *
   * @private
   * @param {Array} results - Search results
   * @param {Object} options - Enhancement options
   * @returns {Promise<Array>} Enhanced results
   */
  async enhanceWithGraph(results, options) {
    const { userId, orgId, project, includeExpired } = options;

    const enhanced = [];

    for (const result of results) {
      const memoryId = result.id || result.memory?.id;
      if (!memoryId || !this.graphStore) {
        enhanced.push(result);
        continue;
      }

      try {
        // Get related memories through graph
        const related = await this.graphStore.getRelatedMemories(memoryId, {
          maxDepth: 2,
          includeExpired,
          user_id: userId,
          org_id: orgId,
          project
        });

        // Calculate graph boost based on connectivity
        const graphBoost = Math.min((related?.length || 0) * 0.02, 0.1);

        enhanced.push({
          ...result,
          graphConnections: related?.length || 0,
          graphBoost,
          score: result.score + graphBoost,
          relatedMemories: related?.slice(0, 5) || []
        });
      } catch (error) {
        logger.debug('Graph enhancement failed for memory', {
          memoryId,
          error: error.message
        });
        enhanced.push(result);
      }
    }

    return enhanced;
  }

  // ==========================================
  // Temporal Categorization
  // ==========================================

  /**
   * Categorize results by temporal status
   *
   * @private
   * @param {Array} results - Search results
   * @returns {Object} Categorized results
   */
  categorizeByTemporalStatus(results) {
    const categories = {
      active: [],
      expired: [],
      historical: [],
      archived: []
    };

    const now = new Date();

    for (const result of results) {
      const temporalStatus = this.determineTemporalStatus(result, now);
      categories[temporalStatus].push(result);
    }

    // Sort each category by score
    for (const category of Object.keys(categories)) {
      categories[category].sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    return categories;
  }

  /**
   * Determine temporal status of a result
   *
   * @private
   * @param {Object} result - Search result
   * @param {Date} now - Current date
   * @returns {string} Temporal status
   */
  determineTemporalStatus(result, now) {
    // Check explicit temporal status from payload
    const payloadStatus = result.payload?.temporal_status ||
                         result.memory?.temporal_status;
    if (payloadStatus && this.config.categories[payloadStatus]) {
      return payloadStatus;
    }

    // Determine from dates
    const documentDate = result.document_date ||
                        result.payload?.document_date ||
                        result.memory?.document_date;
    const updatedAt = result.updated_at ||
                     result.payload?.updated_at ||
                     result.memory?.updated_at;
    const createdAt = result.created_at ||
                     result.payload?.created_at ||
                     result.memory?.created_at;

    const date = documentDate ? new Date(documentDate) :
                 updatedAt ? new Date(updatedAt) :
                 createdAt ? new Date(createdAt) : now;

    const daysSince = (now - date) / (1000 * 60 * 60 * 24);

    // Check if explicitly marked as expired
    const isExpired = result.is_expired ||
                     result.payload?.is_expired ||
                     result.memory?.is_expired ||
                     result.temporal_status === 'expired';

    if (isExpired) {
      return daysSince > this.config.dateRanges.historical ?
        this.config.categories.archived :
        this.config.categories.expired;
    }

    // Categorize by age
    if (daysSince <= this.config.dateRanges.recent) {
      return this.config.categories.active;
    } else if (daysSince <= this.config.dateRanges.medium) {
      return this.config.categories.active;
    } else if (daysSince <= this.config.dateRanges.old) {
      return this.config.categories.historical;
    } else {
      return this.config.categories.archived;
    }
  }

  // ==========================================
  // Temporal Ranking
  // ==========================================

  /**
   * Rank results with temporal awareness
   *
   * @private
   * @param {Array} results - Results to rank
   * @returns {Array} Ranked results
   */
  rankWithTemporalAwareness(results) {
    if (!results || results.length === 0) {
      return [];
    }

    const now = new Date();

    // Score each result with temporal component
    const scored = results.map(result => {
      const temporalStatus = this.determineTemporalStatus(result, now);
      const temporalWeight = this.getTemporalWeight(temporalStatus);

      // Calculate temporal score
      const documentDate = result.document_date || result.created_at;
      const recencyComponent = documentDate ?
        getRecencyComponent(documentDate) :
        { weightedScore: 0.5 };

      // Adjust score based on temporal status
      const adjustedScore = (result.score || 0.5) * temporalWeight +
                           recencyComponent.weightedScore * 0.2;

      return {
        ...result,
        temporalStatus,
        temporalWeight,
        recencyScore: recencyComponent.weightedScore,
        adjustedScore,
        finalScore: adjustedScore
      };
    });

    // Sort by final score
    scored.sort((a, b) => b.finalScore - a.finalScore);

    return scored;
  }

  /**
   * Get weight multiplier for temporal status
   *
   * @private
   * @param {string} status - Temporal status
   * @returns {number} Weight multiplier
   */
  getTemporalWeight(status) {
    switch (status) {
      case this.config.categories.active:
        return 1.0;
      case this.config.categories.expired:
        return 0.8;
      case this.config.categories.historical:
        return 0.6;
      case this.config.categories.archived:
        return 0.4;
      default:
        return 0.7;
    }
  }

  // ==========================================
  // Timeline Building
  // ==========================================

  /**
   * Build timeline view of results
   *
   * @private
   * @param {Array} results - Ranked results
   * @returns {Object} Timeline data
   */
  buildTimeline(results) {
    const timeline = {
      byDate: {},
      byMonth: {},
      byYear: {},
      chronological: [],
      reverseChronological: []
    };

    for (const result of results) {
      const date = this.extractDate(result);
      if (!date) continue;

      const dateStr = date.toISOString().split('T')[0];
      const monthStr = dateStr.slice(0, 7);
      const yearStr = dateStr.slice(0, 4);

      // Add to date buckets
      if (!timeline.byDate[dateStr]) {
        timeline.byDate[dateStr] = [];
      }
      timeline.byDate[dateStr].push(result);

      if (!timeline.byMonth[monthStr]) {
        timeline.byMonth[monthStr] = [];
      }
      timeline.byMonth[monthStr].push(result);

      if (!timeline.byYear[yearStr]) {
        timeline.byYear[yearStr] = [];
      }
      timeline.byYear[yearStr].push(result);
    }

    // Build chronological arrays
    timeline.chronological = [...results].sort((a, b) => {
      const dateA = this.extractDate(a);
      const dateB = this.extractDate(b);
      if (!dateA || !dateB) return 0;
      return dateA - dateB;
    });

    timeline.reverseChronological = [...timeline.chronological].reverse();

    // Add summary
    timeline.summary = {
      totalEvents: results.length,
      dateRange: this.calculateDateRange(results),
      peakDays: this.findPeakDays(timeline.byDate, 5)
    };

    return timeline;
  }

  /**
   * Extract date from result
   *
   * @private
   * @param {Object} result - Search result
   * @returns {Date|null} Extracted date
   */
  extractDate(result) {
    const dateStr = result.document_date ||
                   result.payload?.document_date ||
                   result.memory?.document_date ||
                   result.created_at ||
                   result.payload?.created_at ||
                   result.memory?.created_at;

    if (!dateStr) return null;

    try {
      return new Date(dateStr);
    } catch {
      return null;
    }
  }

  /**
   * Calculate date range of results
   *
   * @private
   * @param {Array} results - Search results
   * @returns {Object} Date range
   */
  calculateDateRange(results) {
    const dates = results
      .map(r => this.extractDate(r))
      .filter(Boolean);

    if (dates.length === 0) {
      return { start: null, end: null, span: 0 };
    }

    const start = new Date(Math.min(...dates));
    const end = new Date(Math.max(...dates));
    const span = (end - start) / (1000 * 60 * 60 * 24);

    return {
      start: start.toISOString(),
      end: end.toISOString(),
      span: Math.round(span)
    };
  }

  /**
   * Find peak days with most results
   *
   * @private
   * @param {Object} byDate - Results grouped by date
   * @param {number} limit - Maximum to return
   * @returns {Array} Peak days
   */
  findPeakDays(byDate, limit) {
    return Object.entries(byDate)
      .map(([date, results]) => ({ date, count: results.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  // ==========================================
  // Statistics
  // ==========================================

  /**
   * Calculate search statistics
   *
   * @private
   * @param {Object} categorized - Categorized results
   * @param {Array} ranked - Ranked results
   * @returns {Object} Statistics
   */
  calculateStatistics(categorized, ranked) {
    const stats = {
      byCategory: {},
      temporalDistribution: {},
      scoreDistribution: {},
      timeRange: {}
    };

    // Category counts
    for (const [category, results] of Object.entries(categorized)) {
      stats.byCategory[category] = {
        count: results.length,
        avgScore: results.length > 0 ?
          results.reduce((sum, r) => sum + (r.score || 0), 0) / results.length :
          0
      };
    }

    // Temporal distribution
    const now = new Date();
    const timeBuckets = {
      lastWeek: 0,
      lastMonth: 0,
      lastQuarter: 0,
      lastYear: 0,
      older: 0
    };

    for (const result of ranked) {
      const date = this.extractDate(result);
      if (!date) {
        timeBuckets.older++;
        continue;
      }

      const daysSince = (now - date) / (1000 * 60 * 60 * 24);

      if (daysSince <= 7) {
        timeBuckets.lastWeek++;
      } else if (daysSince <= 30) {
        timeBuckets.lastMonth++;
      } else if (daysSince <= 90) {
        timeBuckets.lastQuarter++;
      } else if (daysSince <= 365) {
        timeBuckets.lastYear++;
      } else {
        timeBuckets.older++;
      }
    }

    stats.temporalDistribution = timeBuckets;

    // Score distribution
    const scoreBuckets = {
      '0.0-0.2': 0,
      '0.2-0.4': 0,
      '0.4-0.6': 0,
      '0.6-0.8': 0,
      '0.8-1.0': 0
    };

    for (const result of ranked) {
      const score = result.finalScore || result.score || 0;
      if (score < 0.2) scoreBuckets['0.0-0.2']++;
      else if (score < 0.4) scoreBuckets['0.2-0.4']++;
      else if (score < 0.6) scoreBuckets['0.4-0.6']++;
      else if (score < 0.8) scoreBuckets['0.6-0.8']++;
      else scoreBuckets['0.8-1.0']++;
    }

    stats.scoreDistribution = scoreBuckets;

    // Time range
    stats.timeRange = this.calculateDateRange(ranked);

    return stats;
  }

  // ==========================================
  // Utility Methods
  // ==========================================

  /**
   * Filter results by temporal status
   *
   * @param {Array} results - Results to filter
   * @param {string} status - Temporal status to filter by
   * @returns {Array} Filtered results
   */
  filterByTemporalStatus(results, status) {
    const now = new Date();
    return results.filter(result =>
      this.determineTemporalStatus(result, now) === status
    );
  }

  /**
   * Get temporal summary of results
   *
   * @param {Array} results - Results to analyze
   * @returns {Object} Temporal summary
   */
  getTemporalSummary(results) {
    const now = new Date();
    const categorized = this.categorizeByTemporalStatus(results);

    return {
      total: results.length,
      active: categorized.active.length,
      expired: categorized.expired.length,
      historical: categorized.historical.length,
      archived: categorized.archived.length,
      percentages: {
        active: results.length > 0 ? (categorized.active.length / results.length * 100).toFixed(1) : 0,
        expired: results.length > 0 ? (categorized.expired.length / results.length * 100).toFixed(1) : 0,
        historical: results.length > 0 ? (categorized.historical.length / results.length * 100).toFixed(1) : 0,
        archived: results.length > 0 ? (categorized.archived.length / results.length * 100).toFixed(1) : 0
      },
      dateRange: this.calculateDateRange(results)
    };
  }
}

// ==========================================
// Convenience Functions
// ==========================================

/**
 * Create PanoramaSearch instance with default configuration
 *
 * @param {Object} options - Configuration options
 * @returns {PanoramaSearch} Configured instance
 */
export function createPanoramaSearch(options = {}) {
  return new PanoramaSearch(options);
}

/**
 * Panorama search convenience function
 *
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @returns {Promise<Object>} Panorama search results
 */
export async function searchPanorama(query, options = {}) {
  const panorama = new PanoramaSearch(options);
  return panorama.search(query, options);
}

/**
 * Get temporal summary of memories
 *
 * @param {Array} memories - Memories to analyze
 * @returns {Object} Temporal summary
 */
export function getTemporalSummary(memories) {
  const panorama = new PanoramaSearch();
  return panorama.getTemporalSummary(memories);
}

// ==========================================
// Export
// ==========================================

export default {
  PanoramaSearch,
  createPanoramaSearch,
  searchPanorama,
  getTemporalSummary,
  CONFIG
};

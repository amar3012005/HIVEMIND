/**
 * Recall Ranker
 *
 * Final result ordering with configurable ranking strategies
 * Implements hybrid ranking combining multiple signals
 *
 * @module recall/ranker
 */

import scorer from './scorer.js';
const { scoreAndRank: baseScoreAndRank, calculateScoreStats } = scorer;

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // Default ranking strategy
  defaultStrategy: 'combined',

  // Available strategies
  strategies: {
    combined: 'combined',           // Weighted combination of all factors
    vectorOnly: 'vectorOnly',       // Vector similarity only
    recencyOnly: 'recencyOnly',     // Recency only
    importanceOnly: 'importanceOnly', // Importance only
    ebbinghausOnly: 'ebbinghausOnly', // Ebbinghaus decay only
    hybrid: 'hybrid'                // Multi-stage hybrid ranking
  },

  // Hybrid ranking configuration
  hybrid: {
    stage1Limit: 50,    // First stage: retrieve more candidates
    stage2Limit: 20,    // Second stage: rank top candidates
    minScore: 0.3       // Minimum score threshold
  },

  // Ranking bounds
  bounds: {
    minScore: 0,
    maxScore: 1
  }
};

// ==========================================
// Logger
// ==========================================

const logger = {
  info: (msg, ctx) => console.log(`[RANKER INFO] ${msg}`, ctx || {}),
  warn: (msg, ctx) => console.warn(`[RANKER WARN] ${msg}`, ctx || {}),
  error: (msg, ctx) => console.error(`[RANKER ERROR] ${msg}`, ctx || {}),
  debug: (msg, ctx) => console.debug(`[RANKER DEBUG] ${msg}`, ctx || {})
};

// ==========================================
// Ranking Strategies
// ==========================================

/**
 * Combined ranking strategy (default)
 *
 * Uses weighted combination of all scoring factors
 */
function rankCombined(memories, options = {}) {
  return baseScoreAndRank(memories, options);
}

/**
 * Vector-only ranking strategy
 *
 * Ranks purely by vector similarity
 */
function rankVectorOnly(memories, options = {}) {
  if (!memories || memories.length === 0) return [];

  // Clone and add vector score
  const scored = memories.map(m => ({
    ...m,
    score: m.similarity_score || 0.5,
    scoreBreakdown: {
      vector: m.similarity_score || 0.5,
      recency: 0.5,
      importance: 0.5,
      ebbinghaus: 0.5
    }
  }));

  // Sort by vector score descending
  scored.sort((a, b) => (b.score || 0) - (a.score || 0));

  return scored;
}

/**
 * Recency-only ranking strategy
 *
 * Ranks purely by recency (document_date)
 */
function rankRecencyOnly(memories, options = {}) {
  if (!memories || memories.length === 0) return [];

  const now = new Date();

  // Clone and calculate recency score
  const scored = memories.map(m => {
    const docDate = new Date(m.document_date || m.created_at || now);
    const daysSince = (now - docDate) / (1000 * 60 * 60 * 24);

    // Exponential decay: 2^(-days/30)
    const recencyScore = Math.pow(2, -Math.min(daysSince, 365) / 30);

    return {
      ...m,
      score: recencyScore,
      scoreBreakdown: {
        vector: 0.5,
        recency: recencyScore,
        importance: 0.5,
        ebbinghaus: 0.5
      }
    };
  });

  // Sort by recency score descending
  scored.sort((a, b) => (b.score || 0) - (a.score || 0));

  return scored;
}

/**
 * Importance-only ranking strategy
 *
 * Ranks purely by importance score
 */
function rankImportanceOnly(memories, options = {}) {
  if (!memories || memories.length === 0) return [];

  // Clone and use importance_score directly
  const scored = memories.map(m => ({
    ...m,
    score: m.importance_score || 0.5,
    scoreBreakdown: {
      vector: 0.5,
      recency: 0.5,
      importance: m.importance_score || 0.5,
      ebbinghaus: 0.5
    }
  }));

  // Sort by importance score descending
  scored.sort((a, b) => (b.score || 0) - (a.score || 0));

  return scored;
}

/**
 * Ebbinghaus-only ranking strategy
 *
 * Ranks purely by memory strength and decay
 */
function rankEbbinghausOnly(memories, options = {}) {
  if (!memories || memories.length === 0) return [];

  const now = new Date();

  // Clone and calculate Ebbinghaus score
  const scored = memories.map(m => {
    const lastConfirmed = new Date(m.last_confirmed_at || m.updated_at || m.created_at || now);
    const daysSince = (now - lastConfirmed) / (1000 * 60 * 60 * 24);

    // Ebbinghaus decay: exp(-days/7)
    const decay = Math.exp(-daysSince / 7);

    // Memory strength factor
    const strength = (m.strength || 1.0) / 10;

    // Combined score
    const ebbinghausScore = clamp(decay * strength + (m.recall_count || 0) * 0.05, 0, 1);

    return {
      ...m,
      score: ebbinghausScore,
      scoreBreakdown: {
        vector: 0.5,
        recency: 0.5,
        importance: 0.5,
        ebbinghaus: ebbinghausScore
      }
    };
  });

  // Sort by Ebbinghaus score descending
  scored.sort((a, b) => (b.score || 0) - (a.score || 0));

  return scored;
}

/**
 * Hybrid ranking strategy
 *
 * Two-stage ranking:
 * 1. Retrieve more candidates (stage1Limit)
 * 2. Apply full scoring to top candidates (stage2Limit)
 */
function rankHybrid(memories, options = {}) {
  const {
    stage1Limit = CONFIG.hybrid.stage1Limit,
    stage2Limit = CONFIG.hybrid.stage2Limit,
    minScore = CONFIG.hybrid.minScore
  } = options;

  if (!memories || memories.length === 0) return [];

  // Stage 1: Quick vector-based filtering
  // Sort by vector similarity first (faster)
  const sortedByVector = [...memories].sort((a, b) => {
    const aScore = a.similarity_score || 0;
    const bScore = b.similarity_score || 0;
    return bScore - aScore;
  });

  // Take top candidates for stage 2
  const stage1Candidates = sortedByVector.slice(0, stage1Limit);

  logger.debug('Hybrid ranking stage 1', {
    total: memories.length,
    stage1Candidates: stage1Candidates.length
  });

  // Stage 2: Full scoring on top candidates
  const scored = baseScoreAndRank(stage1Candidates, options);

  // Filter by minimum score
  const filtered = scored.filter(m => m.score >= minScore);

  // Return top stage2Limit results
  return filtered.slice(0, stage2Limit);
}

// ==========================================
// Utility Functions
// ==========================================

/**
 * Clamp value to range
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Normalize scores to 0-1 range
 */
function normalizeScores(memories) {
  if (!memories || memories.length === 0) return [];

  const scores = memories.map(m => m.score || 0);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);

  // Avoid division by zero
  if (maxScore - minScore < 1e-10) {
    return memories.map(m => ({ ...m, normalizedScore: 0.5 }));
  }

  return memories.map(m => ({
    ...m,
    normalizedScore: (m.score - minScore) / (maxScore - minScore)
  }));
}

/**
 * Apply score threshold filter
 */
function filterByScore(memories, minScore) {
  if (!memories || memories.length === 0) return [];

  return memories.filter(m => (m.score || 0) >= minScore);
}

/**
 * Limit results count
 */
function limitResults(memories, limit) {
  if (!memories || memories.length === 0) return [];

  return memories.slice(0, limit);
}

// ==========================================
// Main Ranking Function
// ==========================================

/**
 * Rank memories using specified strategy
 *
 * @param {Array} memories - Memories to rank
 * @param {object} options - Ranking options
 * @returns {Array} Ranked memories
 */
function rank(memories, options = {}) {
  const {
    strategy = CONFIG.defaultStrategy,
    ...restOptions
  } = options;

  const strategies = {
    [CONFIG.strategies.combined]: rankCombined,
    [CONFIG.strategies.vectorOnly]: rankVectorOnly,
    [CONFIG.strategies.recencyOnly]: rankRecencyOnly,
    [CONFIG.strategies.importanceOnly]: rankImportanceOnly,
    [CONFIG.strategies.ebbinghausOnly]: rankEbbinghausOnly,
    [CONFIG.strategies.hybrid]: rankHybrid
  };

  const rankFn = strategies[strategy] || strategies[CONFIG.strategies.combined];

  return rankFn(memories, restOptions);
}

// ==========================================
// Score Statistics
// ==========================================

/**
 * Get ranking statistics
 *
 * @param {Array} memories - Ranked memories
 * @returns {object} Statistics
 */
function getRankingStats(memories) {
  if (!memories || memories.length === 0) {
    return {
      count: 0,
      meanScore: 0,
      medianScore: 0,
      minScore: 0,
      maxScore: 0,
      scoreDistribution: {}
    };
  }

  const scores = memories.map(m => m.score || 0);
  const stats = calculateScoreStats(memories);

  // Score distribution by buckets
  const buckets = [
    { label: '0.0-0.2', min: 0, max: 0.2 },
    { label: '0.2-0.4', min: 0.2, max: 0.4 },
    { label: '0.4-0.6', min: 0.4, max: 0.6 },
    { label: '0.6-0.8', min: 0.6, max: 0.8 },
    { label: '0.8-1.0', min: 0.8, max: 1.0 }
  ];

  const distribution = buckets.map(bucket => ({
    ...bucket,
    count: scores.filter(s => s >= bucket.min && s < bucket.max).length
  }));

  return {
    count: stats.count,
    meanScore: stats.mean,
    medianScore: stats.median,
    minScore: stats.min,
    maxScore: stats.max,
    stdDev: stats.stdDev,
    quartiles: stats.quartiles,
    scoreDistribution: distribution
  };
}

// ==========================================
// Result Formatting
// ==========================================

/**
 * Format ranked results for API response
 *
 * @param {Array} memories - Ranked memories
 * @param {object} options - Formatting options
 * @returns {object} Formatted results
 */
function formatResults(memories, options = {}) {
  const {
    includeScores = true,
    includeBreakdown = false,
    includeMetadata = false,
    limit = 20
  } = options;

  const ranked = limitResults(memories, limit);

  const results = ranked.map(m => ({
    id: m.id,
    content: m.content,
    memory_type: m.memory_type,
    title: m.title,
    tags: m.tags,
    source_platform: m.source_platform,
    document_date: m.document_date,
    importance_score: m.importance_score,
    ...(includeScores && { score: m.score }),
    ...(includeBreakdown && { score_breakdown: m.scoreBreakdown }),
    ...(includeMetadata && {
      score_components: m.scoreComponents,
      score_metadata: m.scoreMetadata
    })
  }));

  return {
    memories: results,
    stats: getRankingStats(memories),
    metadata: {
      totalReturned: results.length,
      totalAvailable: memories.length,
      timestamp: new Date().toISOString()
    }
  };
}

// ==========================================
// A/B Testing Support
// ==========================================

/**
 * Assign variant for A/B testing
 *
 * @param {string} userId - User ID
 * @param {Array} variants - Array of variant names
 * @returns {string} Assigned variant
 */
function assignVariant(userId, variants) {
  if (!userId || !variants || variants.length === 0) {
    return variants[0] || 'control';
  }

  // Deterministic hash-based assignment
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  const index = Math.abs(hash) % variants.length;
  return variants[index];
}

/**
 * Get variant ranking function
 *
 * @param {string} variant - Variant name
 * @returns {function} Ranking function
 */
function getVariantRanker(variant) {
  const variantRankers = {
    control: rankCombined,
    recency_boost: (memories, options) => rankRecencyOnly(memories, options),
    vector_boost: (memories, options) => rankVectorOnly(memories, options),
    hybrid: rankHybrid,
    importance_first: (memories, options) => rankImportanceOnly(memories, options)
  };

  return variantRankers[variant] || variantRankers.control;
}

// ==========================================
// Export
// ==========================================

export default {
  // Main ranking function
  rank,

  // Individual strategies
  rankCombined,
  rankVectorOnly,
  rankRecencyOnly,
  rankImportanceOnly,
  rankEbbinghausOnly,
  rankHybrid,

  // Utilities
  normalizeScores,
  filterByScore,
  limitResults,
  getRankingStats,
  formatResults,

  // A/B testing
  assignVariant,
  getVariantRanker,

  // Configuration
  CONFIG
};

/**
 * Recall Scorer
 *
 * Implements multi-factor scoring algorithm for memory ranking
 * Combines vector similarity, recency bias, Ebbinghaus decay, and user signals
 *
 * @module recall/scorer
 * @description Production-ready scoring with configurable weights and decay parameters
 */

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // Scoring weights (must sum to 1.0)
  weights: {
    vector: 0.4,        // Vector similarity score (0-1)
    recency: 0.3,       // Recency bias with exponential decay
    importance: 0.2,    // Memory importance score (0-1)
    ebbinghaus: 0.1     // Ebbinghaus forgetting curve
  },

  // Recency configuration
  recency: {
    halfLifeDays: 30,   // Memory becomes half as relevant after this many days
    maxAgeDays: 365,    // Maximum age to consider
    recencyBias: 0.7    // Bias toward recency (0-1)
  },

  // Ebbinghaus forgetting curve configuration
  ebbinghaus: {
    halfLifeDays: 7,    // Standard half-life for memory decay
    maxStrength: 10.0,  // Maximum memory strength
    decayRate: 1 / 7,   // Decay rate (1/halfLifeDays)
    recallBoost: 0.15,  // Boost per recall
    confirmBoost: 0.30, // Boost per confirmation
    ignoreDecayThreshold: 0.5 // Strength above which decay is ignored
  },

  // Importance configuration
  importance: {
    baseMultiplier: 1.0,
    highImportanceThreshold: 0.8,
    highImportanceBoost: 0.15,
    lowImportanceThreshold: 0.3,
    lowImportancePenalty: 0.2
  },

  // Scoring bounds
  bounds: {
    minScore: 0,
    maxScore: 1,
    minSimilarity: 0,
    maxSimilarity: 1
  }
};

// ==========================================
// Logger
// ==========================================

const logger = {
  info: (msg, ctx) => console.log(`[SCORER INFO] ${msg}`, ctx || {}),
  warn: (msg, ctx) => console.warn(`[SCORER WARN] ${msg}`, ctx || {}),
  error: (msg, ctx) => console.error(`[SCORER ERROR] ${msg}`, ctx || {}),
  debug: (msg, ctx) => console.debug(`[SCORER DEBUG] ${msg}`, ctx || {})
};

// ==========================================
// Helper Functions
// ==========================================

/**
 * Clamp value to range
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Calculate days between dates
 */
function daysSince(date) {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now - then;
  return diffMs / (1000 * 60 * 60 * 24);
}

/**
 * Calculate hours since date
 */
function hoursSince(date) {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now - then;
  return diffMs / (1000 * 60 * 60);
}

/**
 * Safe division to avoid division by zero
 */
function safeDivide(numerator, denominator, defaultValue = 0) {
  if (Math.abs(denominator) < 1e-10) {
    return defaultValue;
  }
  return numerator / denominator;
}

// ==========================================
// Vector Similarity Scoring
// ==========================================

/**
 * Normalize vector similarity score
 *
 * @param {number} rawScore - Raw similarity from vector search
 * @param {string} metric - Distance metric used (cosine, euclidean, dot)
 * @returns {number} Normalized score (0-1)
 */
function normalizeVectorScore(rawScore, metric = 'cosine') {
  switch (metric) {
    case 'cosine':
      // Cosine similarity is -1 to 1, normalize to 0-1
      return clamp((rawScore + 1) / 2, CONFIG.bounds.minSimilarity, CONFIG.bounds.maxSimilarity);

    case 'euclidean':
      // Euclidean distance: convert to similarity (inverse)
      return clamp(1 - rawScore, CONFIG.bounds.minSimilarity, CONFIG.bounds.maxSimilarity);

    case 'dot':
      // Dot product: apply sigmoid for normalization
      return clamp(1 / (1 + Math.exp(-rawScore)), CONFIG.bounds.minSimilarity, CONFIG.bounds.maxSimilarity);

    default:
      return clamp(rawScore, CONFIG.bounds.minSimilarity, CONFIG.bounds.maxSimilarity);
  }
}

/**
 * Get vector similarity component
 *
 * @param {number} rawScore - Raw similarity from vector search
 * @param {string} metric - Distance metric
 * @returns {object} Component with score and weight
 */
function getVectorComponent(rawScore, metric = 'cosine', treatMissingAsZero = false) {
  if (treatMissingAsZero && (!Number.isFinite(rawScore) || rawScore <= 0)) {
    return {
      name: 'vector',
      rawScore: rawScore || 0,
      normalizedScore: 0,
      weightedScore: 0,
      weight: CONFIG.weights.vector
    };
  }

  const normalizedScore = normalizeVectorScore(rawScore, metric);
  const weightedScore = normalizedScore * CONFIG.weights.vector;

  return {
    name: 'vector',
    rawScore,
    normalizedScore,
    weightedScore,
    weight: CONFIG.weights.vector
  };
}

// ==========================================
// Recency Scoring
// ==========================================

/**
 * Calculate recency score using exponential decay
 *
 * Formula: 2^(-daysSince/halfLifeDays) × bias + (1-bias) × 0.5
 *
 * @param {Date|string} date - Memory date
 * @param {object} options - Recency configuration
 * @returns {object} Component with score and details
 */
function getRecencyComponent(date, options = {}) {
  const {
    halfLifeDays = CONFIG.recency.halfLifeDays,
    recencyBias = CONFIG.recency.recencyBias,
    maxAgeDays = CONFIG.recency.maxAgeDays
  } = options;

  const days = daysSince(date);

  // Clamp days to valid range
  const clampedDays = clamp(days, 0, maxAgeDays);

  // Calculate recency score with bias
  // Base decay: 2^(-days/halfLife)
  const baseDecay = Math.pow(2, -clampedDays / halfLifeDays);

  // Apply recency bias
  // When bias=1: score = baseDecay (full recency focus)
  // When bias=0: score = 0.5 (no recency focus)
  const recencyScore = baseDecay * recencyBias + (1 - recencyBias) * 0.5;

  // Apply penalty for very old memories
  let finalScore = recencyScore;
  if (days > maxAgeDays) {
    finalScore *= 0.5;
  }

  const weightedScore = finalScore * CONFIG.weights.recency;

  return {
    name: 'recency',
    daysSince: days,
    halfLifeDays,
    recencyBias,
    rawScore: recencyScore,
    weightedScore,
    weight: CONFIG.weights.recency
  };
}

// ==========================================
// Importance Scoring
// ==========================================

/**
 * Calculate importance score with boosts/penalties
 *
 * @param {number} baseImportance - Base importance score (0-1)
 * @returns {object} Component with score and details
 */
function getImportanceComponent(baseImportance) {
  // Validate input
  const importance = clamp(baseImportance, 0, 1);

  // Apply multiplier
  let adjustedImportance = importance * CONFIG.importance.baseMultiplier;

  // High importance boost
  if (importance >= CONFIG.importance.highImportanceThreshold) {
    adjustedImportance *= (1 + CONFIG.importance.highImportanceBoost);
  }

  // Low importance penalty
  if (importance <= CONFIG.importance.lowImportanceThreshold) {
    adjustedImportance *= (1 - CONFIG.importance.lowImportancePenalty);
  }

  // Clamp result
  adjustedImportance = clamp(adjustedImportance, 0, 1);

  const weightedScore = adjustedImportance * CONFIG.weights.importance;

  return {
    name: 'importance',
    baseImportance,
    adjustedImportance,
    weightedScore,
    weight: CONFIG.weights.importance
  };
}

// ==========================================
// Ebbinghaus Scoring
// ==========================================

/**
 * Calculate Ebbinghaus forgetting curve retention
 *
 * Formula: exp(-daysSince × decayRate) + recallBoost
 *
 * @param {Date|string} lastConfirmedAt - Last confirmation date
 * @param {number} strength - Memory strength (0-10)
 * @param {number} recallCount - Number of recalls
 * @param {object} options - Ebbinghaus configuration
 * @returns {object} Component with score and details
 */
function getEbbinghausComponent(lastConfirmedAt, strength, recallCount, options = {}) {
  const {
    halfLifeDays = CONFIG.ebbinghaus.halfLifeDays,
    maxStrength = CONFIG.ebbinghaus.maxStrength,
    decayRate = CONFIG.ebbinghaus.decayRate,
    recallBoost = CONFIG.ebbinghaus.recallBoost,
    confirmBoost = CONFIG.ebbinghaus.confirmBoost,
    ignoreDecayThreshold = CONFIG.ebbinghaus.ignoreDecayThreshold
  } = options;

  // Calculate days since last confirmation
  const days = daysSince(lastConfirmedAt);

  // Calculate effective strength with recall boosts
  let effectiveStrength = Math.min(strength || 1.0, maxStrength);
  effectiveStrength += recallCount * recallBoost;
  effectiveStrength += recallCount * confirmBoost;

  // Calculate decay factor
  // If strength is high, decay is slower
  const adjustedDecayRate = decayRate / (effectiveStrength / 2);

  // Calculate retention using exponential decay
  let retention = Math.exp(-days * adjustedDecayRate);

  // Add recall boost to retention
  retention += Math.min(recallCount * recallBoost, 0.3);

  // Clamp retention to valid range
  retention = clamp(retention, 0, 1);

  // For very strong memories, ignore decay
  if (effectiveStrength >= ignoreDecayThreshold * maxStrength) {
    retention = Math.max(retention, 0.8);
  }

  const weightedScore = retention * CONFIG.weights.ebbinghaus;

  return {
    name: 'ebbinghaus',
    daysSince: days,
    strength,
    effectiveStrength,
    decayRate: adjustedDecayRate,
    retention,
    weightedScore,
    weight: CONFIG.weights.ebbinghaus
  };
}

// ==========================================
// Combined Scoring
// ==========================================

/**
 * Calculate combined recall score
 *
 * Formula:
 * finalScore = vector×0.4 + recency×recencyBias×0.3 + importance×0.2 + ebbinghaus×(1-recencyBias)×0.1
 *
 * @param {object} memory - Memory object with all required fields
 * @param {object} options - Scoring options
 * @returns {object} Complete score breakdown and final score
 */
function calculateCombinedScore(memory, options = {}) {
  const {
    vectorScore = 0.5,
    vectorMetric = 'cosine',
    hasVectorSignal = true,
    recencyBias = CONFIG.recency.recencyBias,
    importanceScore = 0.5,
    lastConfirmedAt = new Date(),
    strength = 1.0,
    recallCount = 0,
    documentDate = new Date()
  } = options;

  // Get individual components
  const vectorComponent = getVectorComponent(vectorScore, vectorMetric, !hasVectorSignal);
  const recencyComponent = getRecencyComponent(documentDate, { recencyBias });
  const importanceComponent = getImportanceComponent(importanceScore);
  const ebbinghausComponent = getEbbinghausComponent(lastConfirmedAt, strength, recallCount);

  // Calculate final score with weighted components
  // Note: Recency and Ebbinghaus weights are adjusted by recencyBias
  const finalScore = clamp(
    vectorComponent.weightedScore +
    recencyComponent.weightedScore +
    importanceComponent.weightedScore +
    ebbinghausComponent.weightedScore,
    CONFIG.bounds.minScore,
    CONFIG.bounds.maxScore
  );

  return {
    finalScore,
    components: {
      vector: vectorComponent,
      recency: recencyComponent,
      importance: importanceComponent,
      ebbinghaus: ebbinghausComponent
    },
    breakdown: {
      vector: vectorComponent.weightedScore,
      recency: recencyComponent.weightedScore,
      importance: importanceComponent.weightedScore,
      ebbinghaus: ebbinghausComponent.weightedScore
    },
    metadata: {
      recencyBias,
      timestamp: Date.now()
    }
  };
}

/**
 * Score a single memory for recall
 *
 * @param {object} memory - Memory object from database
 * @param {object} options - Scoring options
 * @returns {object} Scored memory with all fields
 */
function scoreMemory(memory, options = {}) {
  const {
    vectorScore = memory.vectorScore ?? memory.similarity_score ?? 0.5,
    vectorMetric = 'cosine',
    recencyBias = CONFIG.recency.recencyBias
  } = options;

  const resolvedVectorScore = Number.isFinite(memory.vectorScore)
    ? memory.vectorScore
    : Number.isFinite(memory.similarity_score)
      ? memory.similarity_score
      : vectorScore;
  const hasVectorSignal = Number.isFinite(memory.vectorScore)
    ? memory.vectorScore > 0
    : Number.isFinite(memory.similarity_score)
      ? memory.similarity_score > 0
      : false;

  const result = calculateCombinedScore(memory, {
    vectorScore: resolvedVectorScore,
    vectorMetric,
    hasVectorSignal,
    recencyBias,
    importanceScore: memory.importance_score || 0.5,
    lastConfirmedAt: memory.last_confirmed_at || memory.updated_at || memory.created_at,
    strength: memory.strength || 1.0,
    recallCount: memory.recall_count || 0,
    documentDate: memory.document_date || memory.created_at
  });

  return {
    ...memory,
    score: result.finalScore,
    scoreBreakdown: result.breakdown,
    scoreComponents: result.components,
    scoreMetadata: result.metadata
  };
}

// ==========================================
// Batch Scoring
// ==========================================

/**
 * Score and rank multiple memories
 *
 * @param {Array} memories - Array of memory objects
 * @param {object} options - Scoring options
 * @returns {Array} Scored memories sorted by score descending
 */
function scoreAndRank(memories, options = {}) {
  if (!memories || memories.length === 0) {
    return [];
  }

  const scored = memories.map(memory => scoreMemory(memory, options));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored;
}

// ==========================================
// Dynamic Weight Adjustment
// ==========================================

/**
 * Adjust weights based on query type
 *
 * @param {string} query - User query
 * @returns {object} Adjusted weights
 */
function adjustWeightsForQuery(query) {
  const queryLower = (query || '').toLowerCase();
  const weights = { ...CONFIG.weights };

  // Recent/temporal queries boost recency
  if (queryLower.includes('recent') ||
      queryLower.includes('latest') ||
      queryLower.includes('last') ||
      queryLower.includes('today') ||
      queryLower.includes('yesterday') ||
      queryLower.includes('recently')) {
    weights.recency += 0.15;
    weights.vector -= 0.05;
    weights.ebbinghaus -= 0.05;
  }

  // Important/critical queries boost importance
  if (queryLower.includes('important') ||
      queryLower.includes('critical') ||
      queryLower.includes('key') ||
      queryLower.includes('major') ||
      queryLower.includes('urgent')) {
    weights.importance += 0.15;
    weights.vector -= 0.05;
    weights.recency -= 0.05;
  }

  // Specific/factual queries boost vector similarity
  if (queryLower.includes('exactly') ||
      queryLower.includes('specific') ||
      queryLower.includes('precise') ||
      queryLower.includes('correct') ||
      queryLower.includes('true')) {
    weights.vector += 0.15;
    weights.recency -= 0.05;
    weights.importance -= 0.05;
  }

  // Long-term/learning queries boost Ebbinghaus
  if (queryLower.includes('learn') ||
      queryLower.includes('remember') ||
      queryLower.includes('study') ||
      queryLower.includes('skill') ||
      queryLower.includes('knowledge')) {
    weights.ebbinghaus += 0.15;
    weights.vector -= 0.05;
    weights.recency -= 0.05;
  }

  // Normalize weights to sum to 1.0
  const total = weights.vector + weights.recency + weights.importance + weights.ebbinghaus;
  weights.vector /= total;
  weights.recency /= total;
  weights.importance /= total;
  weights.ebbinghaus /= total;

  return weights;
}

// ==========================================
// Score Statistics
// ==========================================

/**
 * Calculate score statistics for a set of memories
 *
 * @param {Array} memories - Scored memories
 * @returns {object} Statistics
 */
function calculateScoreStats(memories) {
  if (!memories || memories.length === 0) {
    return {
      count: 0,
      mean: 0,
      median: 0,
      min: 0,
      max: 0,
      stdDev: 0,
      quartiles: { q1: 0, q3: 0 }
    };
  }

  const scores = memories.map(m => m.score || 0).sort((a, b) => a - b);
  const n = scores.length;

  // Mean
  const mean = scores.reduce((sum, score) => sum + score, 0) / n;

  // Median
  const median = n % 2 === 0
    ? (scores[n / 2 - 1] + scores[n / 2]) / 2
    : scores[Math.floor(n / 2)];

  // Min/Max
  const min = scores[0];
  const max = scores[n - 1];

  // Standard deviation
  const variance = scores.reduce((sum, score) => sum + Math.pow(score - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  // Quartiles
  const q1Index = Math.floor(n * 0.25);
  const q3Index = Math.floor(n * 0.75);
  const quartiles = {
    q1: scores[q1Index],
    q3: scores[q3Index]
  };

  // Percentiles
  const p95Index = Math.floor(n * 0.95);
  const p99Index = Math.floor(n * 0.99);

  return {
    count: n,
    mean,
    median,
    min,
    max,
    stdDev,
    quartiles,
    percentiles: {
      p95: scores[p95Index],
      p99: scores[p99Index]
    }
  };
}

// ==========================================
// Quality Metrics
// ==========================================

/**
 * Calculate NDCG@k for ranking quality
 *
 * @param {Array} rankedMemories - Ranked memories
 * @param {number} k - Cutoff position
 * @returns {number} NDCG score
 */
function calculateNDCG(rankedMemories, k = 10) {
  if (!rankedMemories || rankedMemories.length === 0) {
    return 0;
  }

  // Get relevance scores (using importance_score as proxy)
  const relevanceScores = rankedMemories
    .slice(0, k)
    .map(m => m.importance_score || 0);

  // Calculate DCG
  let dcg = 0;
  for (let i = 0; i < relevanceScores.length; i++) {
    dcg += relevanceScores[i] / Math.log2(i + 2);
  }

  // Calculate IDCG (ideal DCG with sorted relevance)
  const sortedRelevance = [...relevanceScores].sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < sortedRelevance.length; i++) {
    idcg += sortedRelevance[i] / Math.log2(i + 2);
  }

  // Calculate NDCG
  if (idcg === 0) return 0;
  return dcg / idcg;
}

/**
 * Calculate MRR (Mean Reciprocal Rank)
 *
 * @param {Array} rankedMemories - Ranked memories
 * @param {function} isRelevant - Function to check if memory is relevant
 * @returns {number} MRR score
 */
function calculateMRR(rankedMemories, isRelevant) {
  if (!rankedMemories || rankedMemories.length === 0) {
    return 0;
  }

  for (let i = 0; i < rankedMemories.length; i++) {
    if (isRelevant(rankedMemories[i])) {
      return 1 / (i + 1);
    }
  }

  return 0;
}

/**
 * Calculate Precision@k
 *
 * @param {Array} rankedMemories - Ranked memories
 * @param {number} k - Cutoff position
 * @param {function} isRelevant - Function to check if memory is relevant
 * @returns {number} Precision@k
 */
function calculatePrecisionAtK(rankedMemories, k, isRelevant) {
  if (!rankedMemories || rankedMemories.length === 0) {
    return 0;
  }

  const relevantCount = rankedMemories
    .slice(0, k)
    .filter(m => isRelevant(m)).length;

  return relevantCount / k;
}

// ==========================================
// Export
// ==========================================

export default {
  // Core scoring functions
  calculateCombinedScore,
  scoreMemory,
  scoreAndRank,

  // Individual components
  getVectorComponent,
  getRecencyComponent,
  getImportanceComponent,
  getEbbinghausComponent,

  // Utilities
  normalizeVectorScore,
  adjustWeightsForQuery,
  calculateScoreStats,
  calculateNDCG,
  calculateMRR,
  calculatePrecisionAtK,

  // Configuration
  CONFIG
};

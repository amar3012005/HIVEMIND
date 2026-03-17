/**
 * Reciprocal Rank Fusion (RRF)
 *
 * Implements RRF algorithm for combining search results from multiple sources
 * Provides robust ranking when different search methods have varying quality
 *
 * @module search/fusion
 */

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // RRF parameters
  rrf: {
    k: 60, // Constant for RRF calculation
    minScore: 0.01 // Minimum score threshold
  },

  // Weight configuration
  weights: {
    vector: 1.0,
    keyword: 1.0,
    graph: 1.0
  },

  // Fusion strategies
  strategies: {
    rrf: 'rrf',           // Reciprocal Rank Fusion
    weighted: 'weighted', // Weighted average
    max: 'max',           // Maximum score
    average: 'average'    // Simple average
  }
};

// ==========================================
// Logger
// ==========================================

const logger = {
  info: (msg, ctx) => console.log(`[FUSION INFO] ${msg}`, ctx || {}),
  warn: (msg, ctx) => console.warn(`[FUSION WARN] ${msg}`, ctx || {}),
  error: (msg, ctx) => console.error(`[FUSION ERROR] ${msg}`, ctx || {}),
  debug: (msg, ctx) => console.debug(`[FUSION DEBUG] ${msg}`, ctx || {})
};

// ==========================================
// Reciprocal Rank Fusion (RRF)
// ==========================================

/**
 * Calculate RRF score
 *
 * Formula: RRF(k, rank) = 1 / (k + rank)
 *
 * @param {number} rank - Result rank (1-indexed)
 * @param {number} k - RRF constant
 * @returns {number} RRF score
 */
function calculateRRFScore(rank, k = CONFIG.rrf.k) {
  return 1 / (k + rank);
}

/**
 * Fuse results using RRF
 *
 * @param {Array} resultSets - Array of result sets from different search methods
 * @param {object} options - Fusion options
 * @returns {Array} Fused results
 */
function fuseRRF(resultSets, options = {}) {
  const {
    k = CONFIG.rrf.k,
    weights = CONFIG.weights,
    minScore = CONFIG.rrf.minScore
  } = options;

  // Map to store fused results
  const fused = new Map();

  // Process each result set
  resultSets.forEach((results, setIndex) => {
    const weight = weights[`set${setIndex}`] || weights.vector || 1.0;

    results.forEach((result, rank) => {
      const rrfScore = calculateRRFScore(rank + 1, k);
      const weightedScore = rrfScore * weight;

      if (!fused.has(result.id)) {
        fused.set(result.id, {
          ...result,
          rrfScores: [],
          totalScore: 0
        });
      }

      const entry = fused.get(result.id);
      entry.rrfScores.push({
        setIndex,
        rank: rank + 1,
        score: rrfScore,
        weightedScore
      });
      entry.totalScore += weightedScore;
    });
  });

  // Convert to array and filter by minimum score
  const results = Array.from(fused.values())
    .filter(r => r.totalScore >= minScore)
    .map(r => ({
      ...r,
      score: r.totalScore,
      rrfDetails: r.rrfScores
    }));

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results;
}

// ==========================================
// Weighted Average Fusion
// ==========================================

/**
 * Fuse results using weighted average
 *
 * @param {Array} resultSets - Array of result sets
 * @param {object} options - Fusion options
 * @returns {Array} Fused results
 */
function fuseWeightedAverage(resultSets, options = {}) {
  const {
    weights = CONFIG.weights,
    minScore = CONFIG.rrf.minScore
  } = options;

  const fused = new Map();

  resultSets.forEach((results, setIndex) => {
    const weight = weights[`set${setIndex}`] || weights.vector || 1.0;

    results.forEach(result => {
      if (!fused.has(result.id)) {
        fused.set(result.id, {
          ...result,
          scores: [],
          totalWeightedScore: 0,
          totalWeight: 0
        });
      }

      const entry = fused.get(result.id);
      entry.scores.push({
        setIndex,
        score: result.score,
        weightedScore: result.score * weight
      });
      entry.totalWeightedScore += result.score * weight;
      entry.totalWeight += weight;
    });
  });

  // Calculate final scores and filter
  const results = Array.from(fused.values())
    .filter(r => r.totalWeightedScore / r.totalWeight >= minScore)
    .map(r => ({
      ...r,
      score: r.totalWeightedScore / r.totalWeight,
      scoreDetails: r.scores
    }));

  results.sort((a, b) => b.score - a.score);

  return results;
}

// ==========================================
// Max Fusion
// ==========================================

/**
 * Fuse results using maximum score
 *
 * @param {Array} resultSets - Array of result sets
 * @param {object} options - Fusion options
 * @returns {Array} Fused results
 */
function fuseMax(resultSets, options = {}) {
  const {
    minScore = CONFIG.rrf.minScore
  } = options;

  const fused = new Map();

  resultSets.forEach((results, setIndex) => {
    results.forEach(result => {
      if (!fused.has(result.id)) {
        fused.set(result.id, {
          ...result,
          scores: []
        });
      }

      const entry = fused.get(result.id);
      entry.scores.push({
        setIndex,
        score: result.score
      });
    });
  });

  // Find maximum score for each result
  const results = Array.from(fused.values())
    .filter(r => Math.max(...r.scores.map(s => s.score)) >= minScore)
    .map(r => ({
      ...r,
      score: Math.max(...r.scores.map(s => s.score)),
      scoreDetails: r.scores
    }));

  results.sort((a, b) => b.score - a.score);

  return results;
}

// ==========================================
// Simple Average Fusion
// ==========================================

/**
 * Fuse results using simple average
 *
 * @param {Array} resultSets - Array of result sets
 * @param {object} options - Fusion options
 * @returns {Array} Fused results
 */
function fuseAverage(resultSets, options = {}) {
  const {
    minScore = CONFIG.rrf.minScore
  } = options;

  const fused = new Map();

  resultSets.forEach((results, setIndex) => {
    results.forEach(result => {
      if (!fused.has(result.id)) {
        fused.set(result.id, {
          ...result,
          scores: []
        });
      }

      const entry = fused.get(result.id);
      entry.scores.push({
        setIndex,
        score: result.score
      });
    });
  });

  // Calculate average score
  const results = Array.from(fused.values())
    .filter(r => {
      const avg = r.scores.reduce((sum, s) => sum + s.score, 0) / r.scores.length;
      return avg >= minScore;
    })
    .map(r => ({
      ...r,
      score: r.scores.reduce((sum, s) => sum + s.score, 0) / r.scores.length,
      scoreDetails: r.scores
    }));

  results.sort((a, b) => b.score - a.score);

  return results;
}

// ==========================================
// Main Fusion Function
// ==========================================

/**
 * Fuse search results using specified strategy
 *
 * @param {Array} resultSets - Array of result sets
 * @param {object} options - Fusion options
 * @returns {Array} Fused results
 */
function fuseResults(resultSets, options = {}) {
  const {
    strategy = CONFIG.strategies.rrf,
    ...restOptions
  } = options;

  const strategies = {
    [CONFIG.strategies.rrf]: fuseRRF,
    [CONFIG.strategies.weighted]: fuseWeightedAverage,
    [CONFIG.strategies.max]: fuseMax,
    [CONFIG.strategies.average]: fuseAverage
  };

  const fuseFn = strategies[strategy] || strategies[CONFIG.strategies.rrf];

  return fuseFn(resultSets, restOptions);
}

// ==========================================
// Quality Metrics
// ==========================================

/**
 * Calculate Reciprocal Rank Fusion quality metrics
 *
 * @param {Array} fusedResults - Fused results
 * @param {Array} referenceResults - Reference (ground truth) results
 * @returns {object} Quality metrics
 */
function calculateFusionQuality(fusedResults, referenceResults) {
  if (!fusedResults || fusedResults.length === 0) {
    return {
      precisionAt1: 0,
      precisionAt5: 0,
      precisionAt10: 0,
      recall: 0,
      ndcg: 0
    };
  }

  // Create set of reference result IDs
  const referenceSet = new Set(referenceResults.map(r => r.id));

  // Calculate metrics
  const fusedIds = fusedResults.map(r => r.id);

  const precisionAt1 = referenceSet.has(fusedIds[0]) ? 1 : 0;
  const precisionAt5 = fusedIds.slice(0, 5).filter(id => referenceSet.has(id)).length / 5;
  const precisionAt10 = fusedIds.slice(0, 10).filter(id => referenceSet.has(id)).length / 10;

  const relevantFound = fusedIds.filter(id => referenceSet.has(id)).length;
  const recall = referenceResults.length > 0 ? relevantFound / referenceResults.length : 0;

  // Calculate NDCG
  let dcg = 0;
  for (let i = 0; i < Math.min(10, fusedIds.length); i++) {
    if (referenceSet.has(fusedIds[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }

  // Ideal DCG
  let idcg = 0;
  for (let i = 0; i < Math.min(10, referenceResults.length); i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  const ndcg = idcg > 0 ? dcg / idcg : 0;

  return {
    precisionAt1,
    precisionAt5,
    precisionAt10,
    recall,
    ndcg,
    relevantFound,
    totalRelevant: referenceResults.length
  };
}

/**
 * Calculate inter-set agreement
 *
 * @param {Array} resultSets - Array of result sets
 * @returns {object} Agreement metrics
 */
function calculateInterSetAgreement(resultSets) {
  if (resultSets.length < 2) {
    return {
      agreementScore: 0,
      overlaps: []
    };
  }

  // Calculate pairwise overlaps
  const overlaps = [];
  let totalOverlap = 0;

  for (let i = 0; i < resultSets.length; i++) {
    for (let j = i + 1; j < resultSets.length; j++) {
      const set1Ids = new Set(resultSets[i].map(r => r.id));
      const set2Ids = new Set(resultSets[j].map(r => r.id));

      const intersection = [...set1Ids].filter(id => set2Ids.has(id));
      const union = new Set([...set1Ids, ...set2Ids]);

      const jaccard = union.size > 0 ? intersection.length / union.size : 0;

      overlaps.push({
        set1: i,
        set2: j,
        jaccardSimilarity: jaccard,
        overlapCount: intersection.length,
        totalSet1: resultSets[i].length,
        totalSet2: resultSets[j].length
      });

      totalOverlap += jaccard;
    }
  }

  const averageAgreement = overlaps.length > 0 ? totalOverlap / overlaps.length : 0;

  return {
    agreementScore: averageAgreement,
    overlaps,
    numComparisons: overlaps.length
  };
}

// ==========================================
// Export
// ==========================================

export default {
  // Fusion strategies
  fuseRRF,
  fuseWeightedAverage,
  fuseMax,
  fuseAverage,
  fuseResults,

  // Quality metrics
  calculateFusionQuality,
  calculateInterSetAgreement,

  // Configuration
  CONFIG
};

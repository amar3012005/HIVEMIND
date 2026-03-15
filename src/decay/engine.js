/**
 * Ebbinghaus Decay Engine
 *
 * Implements S(t) = exp(-t/τ) forgetting curve for memory strength decay
 * Tracks memory strength, recall count, and decay over time
 *
 * @module decay/engine
 */

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // Default parameters
  defaults: {
    initialStrength: 1.0,
    maxStrength: 10.0,
    halfLifeDays: 7,
    decayRate: 1 / 7,  // 1/halfLifeDays
    minStrength: 0.1
  },

  // Boost parameters
  boosts: {
    recall: 0.15,      // Strength boost per recall
    confirmation: 0.30, // Strength boost per confirmation
    review: 0.10,      // Strength boost per scheduled review
    initialReview: 0.25 // Boost for first review
  },

  // Decay thresholds
  thresholds: {
    ignoreDecayBelow: 0.5,  // Strength above which decay is ignored
    archiveBelow: 0.05,     // Strength below which memory is archived
    expireBelow: 0.01       // Strength below which memory expires
  },

  // Time constants
  time: {
    dayMs: 24 * 60 * 60 * 1000,
    hourMs: 60 * 60 * 1000,
    minuteMs: 60 * 1000
  }
};

// ==========================================
// Logger
// ==========================================

const logger = {
  info: (msg, ctx) => console.log(`[DECAY INFO] ${msg}`, ctx || {}),
  warn: (msg, ctx) => console.warn(`[DECAY WARN] ${msg}`, ctx || {}),
  error: (msg, ctx) => console.error(`[DECAY ERROR] ${msg}`, ctx || {}),
  debug: (msg, ctx) => console.debug(`[DECAY DEBUG] ${msg}`, ctx || {})
};

// ==========================================
// Core Decay Functions
// ==========================================

/**
 * Calculate memory strength at time t
 *
 * Formula: S(t) = S(0) × exp(-t/τ)
 *
 * @param {number} initialStrength - Initial memory strength
 * @param {number} timeElapsedDays - Time elapsed since last review
 * @param {number} halfLifeDays - Memory half-life in days
 * @returns {number} Current strength
 */
function calculateDecay(initialStrength, timeElapsedDays, halfLifeDays = CONFIG.defaults.halfLifeDays) {
  const decayRate = Math.log(2) / halfLifeDays;
  const currentStrength = initialStrength * Math.exp(-decayRate * timeElapsedDays);
  return Math.max(currentStrength, CONFIG.defaults.minStrength);
}

/**
 * Calculate time until strength reaches threshold
 *
 * Formula: t = -τ × ln(threshold/S(0))
 *
 * @param {number} initialStrength - Initial strength
 * @param {number} threshold - Target strength
 * @param {number} halfLifeDays - Memory half-life
 * @returns {number} Time in days until threshold
 */
function timeToThreshold(initialStrength, threshold, halfLifeDays = CONFIG.defaults.halfLifeDays) {
  const decayRate = Math.log(2) / halfLifeDays;
  const ratio = threshold / initialStrength;

  if (ratio >= 1) return 0; // Already at or below threshold

  return -Math.log(ratio) / decayRate;
}

/**
 * Calculate half-life from strength decay
 *
 * Formula: τ = -t / ln(S(t)/S(0))
 *
 * @param {number} initialStrength - Initial strength
 * @param {number} currentStrength - Current strength
 * @param {number} timeElapsedDays - Time elapsed
 * @returns {number} Calculated half-life
 */
function calculateHalfLife(initialStrength, currentStrength, timeElapsedDays) {
  if (currentStrength <= 0 || initialStrength <= 0) {
    return CONFIG.defaults.halfLifeDays;
  }

  const ratio = currentStrength / initialStrength;
  if (ratio >= 1) return Infinity;

  const decayRate = -Math.log(ratio) / timeElapsedDays;
  return Math.log(2) / decayRate;
}

// ==========================================
// Strength Updates
// ==========================================

/**
 * Update strength after recall
 *
 * Formula: S(new) = min(S(old) + recallBoost, maxStrength)
 *
 * @param {number} currentStrength - Current strength
 * @param {number} recallCount - Number of recalls
 * @param {number} maxStrength - Maximum strength
 * @returns {object} Updated strength and metadata
 */
function updateStrengthAfterRecall(currentStrength, recallCount, maxStrength = CONFIG.defaults.maxStrength) {
  const boost = CONFIG.boosts.recall + (recallCount * 0.01); // Diminishing returns
  const newStrength = Math.min(currentStrength + boost, maxStrength);

  return {
    newStrength,
    boost,
    recallCount: recallCount + 1,
    timestamp: Date.now()
  };
}

/**
 * Update strength after confirmation
 *
 * Formula: S(new) = min(S(old) + confirmBoost, maxStrength)
 *
 * @param {number} currentStrength - Current strength
 * @param {number} maxStrength - Maximum strength
 * @returns {object} Updated strength and metadata
 */
function updateStrengthAfterConfirmation(currentStrength, maxStrength = CONFIG.defaults.maxStrength) {
  const boost = CONFIG.boosts.confirmation;
  const newStrength = Math.min(currentStrength + boost, maxStrength);

  return {
    newStrength,
    boost,
    timestamp: Date.now()
  };
}

/**
 * Update strength after scheduled review
 *
 * Formula: S(new) = min(S(old) + reviewBoost, maxStrength)
 *
 * @param {number} currentStrength - Current strength
 * @param {number} recallCount - Number of recalls
 * @param {boolean} isFirstReview - Whether this is the first review
 * @param {number} maxStrength - Maximum strength
 * @returns {object} Updated strength and metadata
 */
function updateStrengthAfterReview(currentStrength, recallCount, isFirstReview = false, maxStrength = CONFIG.defaults.maxStrength) {
  const boost = isFirstReview ? CONFIG.boosts.initialReview : CONFIG.boosts.review;
  const newStrength = Math.min(currentStrength + boost, maxStrength);

  return {
    newStrength,
    boost,
    recallCount: recallCount + 1,
    timestamp: Date.now()
  };
}

/**
 * Apply decay to strength
 *
 * Formula: S(new) = S(old) × exp(-days/halfLife)
 *
 * @param {number} currentStrength - Current strength
 * @param {number} daysSinceLastReview - Days since last review
 * @param {number} halfLifeDays - Memory half-life
 * @param {number} maxStrength - Maximum strength
 * @returns {object} Updated strength and decay info
 */
function applyDecay(currentStrength, daysSinceLastReview, halfLifeDays = CONFIG.defaults.halfLifeDays, maxStrength = CONFIG.defaults.maxStrength) {
  const decayRate = Math.log(2) / halfLifeDays;
  const decayFactor = Math.exp(-decayRate * daysSinceLastReview);
  const newStrength = Math.max(currentStrength * decayFactor, CONFIG.defaults.minStrength);
  const decayAmount = currentStrength - newStrength;

  return {
    newStrength,
    decayFactor,
    decayAmount,
    daysSinceLastReview,
    halfLifeDays,
    timestamp: Date.now()
  };
}

// ==========================================
// Memory State Management
// ==========================================

/**
 * Calculate current memory state
 *
 * @param {object} memory - Memory object with strength, timestamps, etc.
 * @param {object} options - Configuration options
 * @returns {object} Memory state
 */
function getMemoryState(memory, options = {}) {
  const {
    halfLifeDays = CONFIG.defaults.halfLifeDays,
    maxStrength = CONFIG.defaults.maxStrength,
    now = new Date()
  } = options;

  const lastConfirmedAt = memory.last_confirmed_at ? new Date(memory.last_confirmed_at) : null;
  const createdAt = memory.created_at ? new Date(memory.created_at) : null;

  // Calculate days since last confirmation
  let daysSince = 0;
  if (lastConfirmedAt) {
    daysSince = (now - lastConfirmedAt) / CONFIG.time.dayMs;
  } else if (createdAt) {
    daysSince = (now - createdAt) / CONFIG.time.dayMs;
  }

  // Calculate current strength
  const initialStrength = memory.strength || CONFIG.defaults.initialStrength;
  const currentStrength = calculateDecay(initialStrength, daysSince, halfLifeDays);

  // Calculate retention probability
  const retention = currentStrength / maxStrength;

  // Determine state
  let state;
  if (currentStrength >= CONFIG.thresholds.ignoreDecayBelow) {
    state = 'active';
  } else if (currentStrength >= CONFIG.thresholds.archiveBelow) {
    state = 'dormant';
  } else if (currentStrength >= CONFIG.thresholds.expireBelow) {
    state = 'archivable';
  } else {
    state = 'expired';
  }

  // Calculate next review time
  const nextReviewDays = timeToThreshold(currentStrength, CONFIG.thresholds.ignoreDecayBelow, halfLifeDays);

  return {
    currentStrength,
    initialStrength,
    retention,
    daysSinceLastReview: daysSince,
    halfLifeDays,
    state,
    nextReviewDays,
    nextReviewDate: new Date(now.getTime() + nextReviewDays * CONFIG.time.dayMs),
    recallCount: memory.recall_count || 0,
    importanceScore: memory.importance_score || 0.5,
    memoryType: memory.memory_type,
    timestamp: now.toISOString()
  };
}

/**
 * Check if memory needs review
 *
 * @param {object} memory - Memory object
 * @param {object} options - Configuration options
 * @returns {boolean} Whether memory needs review
 */
function needsReview(memory, options = {}) {
  const state = getMemoryState(memory, options);
  return state.state === 'dormant' || state.state === 'archivable';
}

/**
 * Check if memory is archived
 *
 * @param {object} memory - Memory object
 * @param {object} options - Configuration options
 * @returns {boolean} Whether memory is archived
 */
function isArchived(memory, options = {}) {
  const state = getMemoryState(memory, options);
  return state.state === 'archived' || state.state === 'expired';
}

// ==========================================
// Strength Prediction
// ==========================================

/**
 * Predict strength at future time
 *
 * @param {number} currentStrength - Current strength
 * @param {number} daysFromNow - Days from now
 * @param {number} halfLifeDays - Memory half-life
 * @returns {number} Predicted strength
 */
function predictStrength(currentStrength, daysFromNow, halfLifeDays = CONFIG.defaults.halfLifeDays) {
  const decayRate = Math.log(2) / halfLifeDays;
  return Math.max(currentStrength * Math.exp(-decayRate * daysFromNow), CONFIG.defaults.minStrength);
}

/**
 * Predict strength after multiple reviews
 *
 * @param {number} currentStrength - Current strength
 * @param {number} reviewCount - Number of future reviews
 * @param {number} daysBetweenReviews - Days between reviews
 * @param {number} halfLifeDays - Memory half-life
 * @returns {number} Predicted strength
 */
function predictStrengthAfterReviews(currentStrength, reviewCount, daysBetweenReviews, halfLifeDays = CONFIG.defaults.halfLifeDays) {
  let strength = currentStrength;

  for (let i = 0; i < reviewCount; i++) {
    // Decay until review
    strength = predictStrength(strength, daysBetweenReviews, halfLifeDays);
    // Boost from review
    strength = Math.min(strength + CONFIG.boosts.review, CONFIG.defaults.maxStrength);
  }

  return strength;
}

// ==========================================
// Decay Statistics
// ==========================================

/**
 * Calculate decay statistics for a set of memories
 *
 * @param {Array} memories - Array of memory objects
 * @param {object} options - Configuration options
 * @returns {object} Decay statistics
 */
function calculateDecayStats(memories, options = {}) {
  if (!memories || memories.length === 0) {
    return {
      count: 0,
      meanStrength: 0,
      meanHalfLife: CONFIG.defaults.halfLifeDays,
      stateDistribution: {}
    };
  }

  const states = {
    active: 0,
    dormant: 0,
    archivable: 0,
    expired: 0
  };

  const strengths = [];
  const halfLives = [];

  memories.forEach(memory => {
    const state = getMemoryState(memory, options);
    strengths.push(state.currentStrength);
    halfLives.push(state.halfLifeDays);

    if (state.state in states) {
      states[state.state]++;
    }
  });

  const meanStrength = strengths.reduce((a, b) => a + b, 0) / strengths.length;
  const meanHalfLife = halfLives.reduce((a, b) => a + b, 0) / halfLives.length;

  return {
    count: memories.length,
    meanStrength,
    meanHalfLife,
    stateDistribution: states,
    minStrength: Math.min(...strengths),
    maxStrength: Math.max(...strengths),
    stdDevStrength: Math.sqrt(
      strengths.reduce((sum, s) => sum + Math.pow(s - meanStrength, 2), 0) / strengths.length
    )
  };
}

// ==========================================
// Export
// ==========================================

export default {
  // Core decay functions
  calculateDecay,
  timeToThreshold,
  calculateHalfLife,

  // Strength updates
  updateStrengthAfterRecall,
  updateStrengthAfterConfirmation,
  updateStrengthAfterReview,
  applyDecay,

  // State management
  getMemoryState,
  needsReview,
  isArchived,

  // Prediction
  predictStrength,
  predictStrengthAfterReviews,

  // Statistics
  calculateDecayStats,

  // Configuration
  CONFIG
};

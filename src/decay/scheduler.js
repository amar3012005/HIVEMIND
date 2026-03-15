/**
 * Ebbinghaus Scheduler
 *
 * Calculates optimal review intervals for spaced repetition
 * Implements SM-2 algorithm with HIVE-MIND modifications
 *
 * @module decay/scheduler
 */

import { calculateDecay, predictStrength } from './engine.js';

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // SM-2 algorithm parameters
  sm2: {
    initialInterval: 1,        // First review in 1 day
    maxInterval: 100,          // Maximum interval between reviews
    easeFactor: 2.5,           // Starting ease factor
    minEaseFactor: 1.3,        // Minimum ease factor
    hardInterval: 1,           // Interval for "hard" response
    goodInterval: 1,           // Interval for "good" response
    easyInterval: 4,           // Interval for "easy" response
    easyEaseBoost: 0.15        // Ease factor boost for "easy"
  },

  // HIVE-MIND modifications
  modifications: {
    minInterval: 0.5,          // Minimum 12 hours between reviews
    maxInterval: 365,          // Maximum 1 year between reviews
    decayAdjustment: 0.8,      // Adjust for forgetting curve decay
    importanceBoost: 0.2       // Boost for high importance memories
  },

  // Review quality ratings
  ratings: {
    again: 0,      // Forgot - reset to initial interval
    hard: 1,       // Remembered with difficulty
    good: 2,       // Remembered with some difficulty
    easy: 3        // Remembered effortlessly
  }
};

// ==========================================
// Logger
// ==========================================

const logger = {
  info: (msg, ctx) => console.log(`[SCHEDULER INFO] ${msg}`, ctx || {}),
  warn: (msg, ctx) => console.warn(`[SCHEDULER WARN] ${msg}`, ctx || {}),
  error: (msg, ctx) => console.error(`[SCHEDULER ERROR] ${msg}`, ctx || {}),
  debug: (msg, ctx) => console.debug(`[SCHEDULER DEBUG] ${msg}`, ctx || {})
};

// ==========================================
// SM-2 Algorithm
// ==========================================

/**
 * Calculate next review interval using SM-2
 *
 * @param {number} currentInterval - Current interval in days
 * @param {number} easeFactor - Ease factor
 * @param {number} rating - Quality of recall (0-3)
 * @returns {object} Next interval and updated parameters
 */
function calculateNextInterval(currentInterval, easeFactor, rating) {
  let nextInterval;
  let newEaseFactor = easeFactor;

  switch (rating) {
    case CONFIG.ratings.again:
      // Forgot - reset to initial interval
      nextInterval = CONFIG.sm2.initialInterval;
      newEaseFactor = Math.max(CONFIG.sm2.minEaseFactor, easeFactor - 0.2);
      break;

    case CONFIG.ratings.hard:
      // Remembered with difficulty
      nextInterval = currentInterval * 1.2;
      newEaseFactor = Math.max(CONFIG.sm2.minEaseFactor, easeFactor - 0.15);
      break;

    case CONFIG.ratings.good:
      // Remembered with some difficulty
      nextInterval = currentInterval * 2.5;
      break;

    case CONFIG.ratings.easy:
      // Remembered effortlessly
      nextInterval = currentInterval * CONFIG.sm2.easyInterval;
      newEaseFactor += CONFIG.sm2.easyEaseBoost;
      break;

    default:
      nextInterval = currentInterval;
  }

  // Apply HIVE-MIND modifications
  nextInterval = Math.max(
    CONFIG.modifications.minInterval,
    Math.min(CONFIG.modifications.maxInterval, nextInterval)
  );

  return {
    nextInterval,
    newEaseFactor,
    rating,
    timestamp: Date.now()
  };
}

// ==========================================
// HIVE-MIND Modified Scheduler
// ==========================================

/**
 * Calculate optimal review schedule for a memory
 *
 * @param {object} memory - Memory object
 * @param {object} options - Configuration options
 * @returns {object} Review schedule
 */
function calculateReviewSchedule(memory, options = {}) {
  const {
    halfLifeDays = 7,
    maxStrength = 10,
    now = new Date()
  } = options;

  const lastConfirmedAt = memory.last_confirmed_at ? new Date(memory.last_confirmed_at) : null;
  const createdAt = memory.created_at ? new Date(memory.created_at) : null;

  // Calculate current state
  const daysSinceLastReview = lastConfirmedAt
    ? (now - lastConfirmedAt) / (24 * 60 * 60 * 1000)
    : (now - createdAt) / (24 * 60 * 60 * 1000);

  const currentStrength = memory.strength || 1.0;
  const recallCount = memory.recall_count || 0;
  const importanceScore = memory.importance_score || 0.5;

  // Calculate base interval using SM-2
  const baseInterval = calculateNextInterval(
    Math.max(1, recallCount), // Current interval based on recall count
    CONFIG.sm2.easeFactor,
    CONFIG.ratings.good // Assume "good" for scheduling
  ).nextInterval;

  // Adjust for forgetting curve
  const decayAdjustedInterval = baseInterval * CONFIG.modifications.decayAdjustment;

  // Apply importance boost for high-importance memories
  const importanceAdjustedInterval = importanceScore >= 0.8
    ? decayAdjustedInterval * (1 + CONFIG.modifications.importanceBoost)
    : decayAdjustedInterval;

  // Calculate next review date
  const nextReviewDate = new Date(now.getTime() + importanceAdjustedInterval * 24 * 60 * 60 * 1000);

  // Calculate strength at next review
  const strengthAtReview = predictStrength(currentStrength, importanceAdjustedInterval, halfLifeDays);

  // Determine review priority
  let priority;
  if (strengthAtReview < 0.3) {
    priority = 'urgent';
  } else if (strengthAtReview < 0.5) {
    priority = 'high';
  } else if (strengthAtReview < 0.7) {
    priority = 'medium';
  } else {
    priority = 'low';
  }

  return {
    nextReviewDate,
    nextReviewDays: importanceAdjustedInterval,
    currentStrength,
    strengthAtReview,
    priority,
    recallCount,
    importanceScore,
    halfLifeDays,
    timestamp: now.toISOString()
  };
}

/**
 * Calculate review schedule for multiple memories
 *
 * @param {Array} memories - Array of memory objects
 * @param {object} options - Configuration options
 * @returns {Array} Sorted review schedule
 */
function calculateReviewScheduleBatch(memories, options = {}) {
  const schedules = memories.map(memory => ({
    ...calculateReviewSchedule(memory, options),
    memoryId: memory.id
  }));

  // Sort by next review date (most urgent first)
  schedules.sort((a, b) => a.nextReviewDate - b.nextReviewDate);

  return schedules;
}

// ==========================================
// Optimal Interval Calculator
// ==========================================

/**
 * Find optimal interval for target strength
 *
 * @param {number} currentStrength - Current strength
 * @param {number} targetStrength - Target strength at review
 * @param {number} halfLifeDays - Memory half-life
 * @returns {number} Optimal interval in days
 */
function findOptimalInterval(currentStrength, targetStrength, halfLifeDays = 7) {
  // Binary search for optimal interval
  let low = 0;
  let high = 365;
  let optimalInterval = 0;

  for (let i = 0; i < 50; i++) { // 50 iterations for precision
    const mid = (low + high) / 2;
    const strengthAtMid = predictStrength(currentStrength, mid, halfLifeDays);

    if (strengthAtMid >= targetStrength) {
      optimalInterval = mid;
      low = mid;
    } else {
      high = mid;
    }
  }

  return Math.max(CONFIG.modifications.minInterval, optimalInterval);
}

/**
 * Calculate review schedule with target strength
 *
 * @param {object} memory - Memory object
 * @param {number} targetStrength - Target strength at review
 * @param {object} options - Configuration options
 * @returns {object} Optimized review schedule
 */
function calculateOptimizedSchedule(memory, targetStrength = 0.7, options = {}) {
  const {
    halfLifeDays = 7,
    now = new Date()
  } = options;

  const currentStrength = memory.strength || 1.0;
  const optimalInterval = findOptimalInterval(currentStrength, targetStrength, halfLifeDays);

  // Calculate next review date
  const nextReviewDate = new Date(now.getTime() + optimalInterval * 24 * 60 * 60 * 1000);

  // Calculate strength at review
  const strengthAtReview = predictStrength(currentStrength, optimalInterval, halfLifeDays);

  // Determine priority
  let priority;
  if (strengthAtReview < 0.3) {
    priority = 'urgent';
  } else if (strengthAtReview < 0.5) {
    priority = 'high';
  } else if (strengthAtReview < 0.7) {
    priority = 'medium';
  } else {
    priority = 'low';
  }

  return {
    nextReviewDate,
    nextReviewDays: optimalInterval,
    currentStrength,
    targetStrength,
    strengthAtReview,
    priority,
    halfLifeDays,
    timestamp: now.toISOString()
  };
}

// ==========================================
// Batch Processing
// ==========================================

/**
 * Get all memories needing review within a time window
 *
 * @param {Array} memories - Array of memory objects
 * @param {object} window - Time window {start, end}
 * @param {object} options - Configuration options
 * @returns {Array} Memories needing review
 */
function getMemoriesNeedingReview(memories, window, options = {}) {
  const { start, end } = window;
  const schedules = calculateReviewScheduleBatch(memories, options);

  return schedules.filter(schedule => {
    const reviewDate = new Date(schedule.nextReviewDate);
    return reviewDate >= start && reviewDate <= end;
  });
}

/**
 * Get daily review queue
 *
 * @param {Array} memories - Array of memory objects
 * @param {object} options - Configuration options
 * @returns {Array} Daily review queue
 */
function getDailyReviewQueue(memories, options = {}) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  return getMemoriesNeedingReview(memories, { start: startOfDay, end: endOfDay }, options);
}

/**
 * Get weekly review queue
 *
 * @param {Array} memories - Array of memory objects
 * @param {object} options - Configuration options
 * @returns {Array} Weekly review queue
 */
function getWeeklyReviewQueue(memories, options = {}) {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 7);

  return getMemoriesNeedingReview(memories, { start: startOfWeek, end: endOfWeek }, options);
}

// ==========================================
// Statistics
// ==========================================

/**
 * Calculate review statistics
 *
 * @param {Array} memories - Array of memory objects
 * @param {object} options - Configuration options
 * @returns {object} Review statistics
 */
function calculateReviewStats(memories, options = {}) {
  if (!memories || memories.length === 0) {
    return {
      total: 0,
      urgent: 0,
      high: 0,
      medium: 0,
      low: 0,
      meanNextReviewDays: 0
    };
  }

  const schedules = calculateReviewScheduleBatch(memories, options);

  const stats = {
    total: schedules.length,
    urgent: 0,
    high: 0,
    medium: 0,
    low: 0,
    meanNextReviewDays: 0
  };

  let totalDays = 0;

  schedules.forEach(schedule => {
    stats[schedule.priority]++;
    totalDays += schedule.nextReviewDays;
  });

  stats.meanNextReviewDays = totalDays / schedules.length;

  return stats;
}

// ==========================================
// Export
// ==========================================

export default {
  // SM-2 algorithm
  calculateNextInterval,

  // HIVE-MIND scheduler
  calculateReviewSchedule,
  calculateReviewScheduleBatch,
  calculateOptimizedSchedule,

  // Interval calculation
  findOptimalInterval,

  // Batch processing
  getMemoriesNeedingReview,
  getDailyReviewQueue,
  getWeeklyReviewQueue,

  // Statistics
  calculateReviewStats,

  // Configuration
  CONFIG
};

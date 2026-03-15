/**
 * Ebbinghaus Archive Manager
 *
 * Auto-archives stale memories based on decay and retention
 * Implements configurable retention policies
 *
 * @module decay/archive
 */

import { getMemoryState, calculateDecay } from './engine.js';
import { calculateReviewSchedule } from './scheduler.js';

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // Archive thresholds
  thresholds: {
    // Strength below which memory is archived
    archiveStrength: 0.05,
    // Days since last review before archiving
    archiveDays: 365,
    // Days since last review before permanent deletion
    deleteDays: 730,
    // Minimum strength to keep active
    activeThreshold: 0.5
  },

  // Archive behavior
  behavior: {
    // Whether to archive or delete
    archiveOnly: true,
    // Whether to notify before archiving
    notifyBefore: true,
    // Notification lead time in days
    notifyLeadDays: 7,
    // Batch size for processing
    batchSize: 100
  },

  // Retention policies
  retention: {
    // Default retention period in days
    defaultDays: 365,
    // Long-term retention for important memories
    longTermDays: 3650, // 10 years
    // Short-term for low importance
    shortTermDays: 30
  }
};

// ==========================================
// Logger
// ==========================================

const logger = {
  info: (msg, ctx) => console.log(`[ARCHIVE INFO] ${msg}`, ctx || {}),
  warn: (msg, ctx) => console.warn(`[ARCHIVE WARN] ${msg}`, ctx || {}),
  error: (msg, ctx) => console.error(`[ARCHIVE ERROR] ${msg}`, ctx || {}),
  debug: (msg, ctx) => console.debug(`[ARCHIVE DEBUG] ${msg}`, ctx || {})
};

// ==========================================
// Archive Status
// ==========================================

/**
 * Get archive status for a memory
 *
 * @param {object} memory - Memory object
 * @param {object} options - Configuration options
 * @returns {object} Archive status
 */
function getArchiveStatus(memory, options = {}) {
  const {
    now = new Date(),
    thresholds = CONFIG.thresholds,
    behavior = CONFIG.behavior
  } = options;

  const state = getMemoryState(memory, { now });
  const reviewSchedule = calculateReviewSchedule(memory, { now });

  // Calculate days since last review
  const lastConfirmedAt = memory.last_confirmed_at ? new Date(memory.last_confirmed_at) : null;
  const daysSinceLastReview = lastConfirmedAt
    ? (now - lastConfirmedAt) / (24 * 60 * 60 * 1000)
    : 0;

  // Determine archive status
  let status;
  let reason;

  if (state.currentStrength <= thresholds.archiveStrength) {
    status = 'archivable';
    reason = 'strength_below_threshold';
  } else if (daysSinceLastReview >= thresholds.archiveDays) {
    status = 'archivable';
    reason = 'no_review_since_threshold';
  } else if (daysSinceLastReview >= thresholds.deleteDays) {
    status = 'deletable';
    reason = 'no_review_since_delete_threshold';
  } else if (state.state === 'expired') {
    status = 'archivable';
    reason = 'memory_expired';
  } else if (state.state === 'archived') {
    status = 'archived';
    reason = 'already_archived';
  } else if (state.state === 'expired') {
    status = 'deletable';
    reason = 'memory_expired';
  } else {
    status = 'active';
    reason = 'memory_active';
  }

  // Check if notification is needed
  const needsNotification = behavior.notifyBefore &&
    status === 'archivable' &&
    daysSinceLastReview >= (thresholds.archiveDays - behavior.notifyLeadDays);

  return {
    status,
    reason,
    currentStrength: state.currentStrength,
    daysSinceLastReview,
    nextReviewDays: reviewSchedule.nextReviewDays,
    needsNotification,
    notificationDate: needsNotification
      ? new Date(now.getTime() - behavior.notifyLeadDays * 24 * 60 * 60 * 1000)
      : null,
    timestamp: now.toISOString()
  };
}

/**
 * Check if memory should be archived
 *
 * @param {object} memory - Memory object
 * @param {object} options - Configuration options
 * @returns {boolean} Whether memory should be archived
 */
function shouldArchive(memory, options = {}) {
  const status = getArchiveStatus(memory, options);
  return status.status === 'archivable';
}

/**
 * Check if memory should be deleted
 *
 * @param {object} memory - Memory object
 * @param {object} options - Configuration options
 * @returns {boolean} Whether memory should be deleted
 */
function shouldDelete(memory, options = {}) {
  const status = getArchiveStatus(memory, options);
  return status.status === 'deletable';
}

// ==========================================
// Archive Operations
// ==========================================

/**
 * Archive a single memory
 *
 * @param {object} memory - Memory object
 * @param {object} options - Configuration options
 * @returns {object} Archive result
 */
function archiveMemory(memory, options = {}) {
  const {
    archiveDate = new Date(),
    archiveReason = 'auto_decay',
    archiveBy = 'system'
  } = options;

  logger.info('Archiving memory', {
    memoryId: memory.id,
    currentStrength: memory.strength,
    daysSinceLastReview: (archiveDate - new Date(memory.last_confirmed_at || memory.created_at)) / (24 * 60 * 60 * 1000)
  });

  return {
    memoryId: memory.id,
    archivedAt: archiveDate.toISOString(),
    archiveReason,
    archiveBy,
    previousStrength: memory.strength,
    previousRecallCount: memory.recall_count,
    success: true
  };
}

/**
 * Delete a single memory
 *
 * @param {object} memory - Memory object
 * @param {object} options - Configuration options
 * @returns {object} Delete result
 */
function deleteMemory(memory, options = {}) {
  const {
    deleteDate = new Date(),
    deleteReason = 'auto_decay_exceeded',
    deleteBy = 'system'
  } = options;

  logger.warn('Deleting memory', {
    memoryId: memory.id,
    currentStrength: memory.strength,
    daysSinceLastReview: (deleteDate - new Date(memory.last_confirmed_at || memory.created_at)) / (24 * 60 * 60 * 1000)
  });

  return {
    memoryId: memory.id,
    deletedAt: deleteDate.toISOString(),
    deleteReason,
    deleteBy,
    previousStrength: memory.strength,
    previousRecallCount: memory.recall_count,
    success: true
  };
}

// ==========================================
// Batch Operations
// ==========================================

/**
 * Find memories to archive
 *
 * @param {Array} memories - Array of memory objects
 * @param {object} options - Configuration options
 * @returns {Array} Memories to archive
 */
function findMemoriesToArchive(memories, options = {}) {
  return memories.filter(memory => shouldArchive(memory, options));
}

/**
 * Find memories to delete
 *
 * @param {Array} memories - Array of memory objects
 * @param {object} options - Configuration options
 * @returns {Array} Memories to delete
 */
function findMemoriesToDelete(memories, options = {}) {
  return memories.filter(memory => shouldDelete(memory, options));
}

/**
 * Process archive batch
 *
 * @param {Array} memories - Array of memory objects
 * @param {object} options - Configuration options
 * @returns {object} Archive batch result
 */
function processArchiveBatch(memories, options = {}) {
  const {
    batchSize = CONFIG.behavior.batchSize,
    archiveDate = new Date()
  } = options;

  const toArchive = findMemoriesToArchive(memories, options);
  const toDelete = findMemoriesToDelete(memories, options);

  // Process in batches
  const archiveResults = [];
  const deleteResults = [];

  for (let i = 0; i < toArchive.length; i += batchSize) {
    const batch = toArchive.slice(i, i + batchSize);
    const batchResults = batch.map(memory => archiveMemory(memory, { archiveDate }));
    archiveResults.push(...batchResults);
  }

  for (let i = 0; i < toDelete.length; i += batchSize) {
    const batch = toDelete.slice(i, i + batchSize);
    const batchResults = batch.map(memory => deleteMemory(memory, { deleteDate }));
    deleteResults.push(...batchResults);
  }

  logger.info('Archive batch processed', {
    totalToArchive: toArchive.length,
    archived: archiveResults.length,
    totalToDelete: toDelete.length,
    deleted: deleteResults.length
  });

  return {
    archiveResults,
    deleteResults,
    totalProcessed: archiveResults.length + deleteResults.length,
    timestamp: archiveDate.toISOString()
  };
}

// ==========================================
// Retention Policy
// ==========================================

/**
 * Get retention period based on memory properties
 *
 * @param {object} memory - Memory object
 * @returns {number} Retention period in days
 */
function getRetentionPeriod(memory) {
  const importanceScore = memory.importance_score || 0.5;

  if (importanceScore >= 0.8) {
    return CONFIG.retention.longTermDays;
  } else if (importanceScore <= 0.3) {
    return CONFIG.retention.shortTermDays;
  } else {
    return CONFIG.retention.defaultDays;
  }
}

/**
 * Calculate retention deadline
 *
 * @param {object} memory - Memory object
 * @param {object} options - Configuration options
 * @returns {object} Retention deadline info
 */
function calculateRetentionDeadline(memory, options = {}) {
  const {
    now = new Date()
  } = options;

  const retentionDays = getRetentionPeriod(memory);
  const lastConfirmedAt = memory.last_confirmed_at ? new Date(memory.last_confirmed_at) : null;
  const createdAt = memory.created_at ? new Date(memory.created_at) : null;

  // Use last confirmed date if available, otherwise creation date
  const referenceDate = lastConfirmedAt || createdAt || now;

  const retentionDeadline = new Date(referenceDate.getTime() + retentionDays * 24 * 60 * 60 * 1000);
  const daysUntilDeadline = (retentionDeadline - now) / (24 * 60 * 60 * 1000);

  return {
    retentionDays,
    referenceDate: referenceDate.toISOString(),
    retentionDeadline: retentionDeadline.toISOString(),
    daysUntilDeadline,
    isPastDeadline: daysUntilDeadline < 0,
    importanceScore: memory.importance_score || 0.5
  };
}

/**
 * Find memories approaching retention deadline
 *
 * @param {Array} memories - Array of memory objects
 * @param {number} leadDays - Days before deadline to flag
 * @param {object} options - Configuration options
 * @returns {Array} Memories approaching deadline
 */
function findMemoriesApproachingDeadline(memories, leadDays = 30, options = {}) {
  const now = new Date();
  const deadlineThreshold = new Date(now.getTime() + leadDays * 24 * 60 * 60 * 1000);

  return memories
    .map(memory => ({
      ...memory,
      retentionDeadline: calculateRetentionDeadline(memory, { now }).retentionDeadline
    }))
    .filter(memory => {
      const deadline = new Date(memory.retentionDeadline);
      return deadline <= deadlineThreshold && deadline >= now;
    });
}

// ==========================================
// Archive Statistics
// ==========================================

/**
 * Calculate archive statistics
 *
 * @param {Array} memories - Array of memory objects
 * @param {object} options - Configuration options
 * @returns {object} Archive statistics
 */
function calculateArchiveStats(memories, options = {}) {
  if (!memories || memories.length === 0) {
    return {
      total: 0,
      active: 0,
      archivable: 0,
      deletable: 0,
      archived: 0,
      meanStrength: 0
    };
  }

  const stats = {
    total: memories.length,
    active: 0,
    archivable: 0,
    deletable: 0,
    archived: 0,
    meanStrength: 0
  };

  let totalStrength = 0;

  memories.forEach(memory => {
    const status = getArchiveStatus(memory, options);
    totalStrength += memory.strength || 0;

    if (status.status === 'active') {
      stats.active++;
    } else if (status.status === 'archivable') {
      stats.archivable++;
    } else if (status.status === 'deletable') {
      stats.deletable++;
    } else if (status.status === 'archived') {
      stats.archived++;
    }
  });

  stats.meanStrength = totalStrength / memories.length;

  return stats;
}

/**
 * Get archive summary
 *
 * @param {Array} memories - Array of memory objects
 * @param {object} options - Configuration options
 * @returns {object} Archive summary
 */
function getArchiveSummary(memories, options = {}) {
  const stats = calculateArchiveStats(memories, options);

  return {
    ...stats,
    archiveRate: (stats.archivable / stats.total * 100).toFixed(2) + '%',
    deleteRate: (stats.deletable / stats.total * 100).toFixed(2) + '%',
    activeRate: (stats.active / stats.total * 100).toFixed(2) + '%'
  };
}

// ==========================================
// Export
// ==========================================

export default {
  // Status functions
  getArchiveStatus,
  shouldArchive,
  shouldDelete,

  // Operations
  archiveMemory,
  deleteMemory,

  // Batch operations
  findMemoriesToArchive,
  findMemoriesToDelete,
  processArchiveBatch,

  // Retention policy
  getRetentionPeriod,
  calculateRetentionDeadline,
  findMemoriesApproachingDeadline,

  // Statistics
  calculateArchiveStats,
  getArchiveSummary,

  // Configuration
  CONFIG
};

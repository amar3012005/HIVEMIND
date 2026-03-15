/**
 * Audit Log Service
 * HIVE-MIND Cross-Platform Context Sync
 *
 * Business logic for audit logging operations
 * - Create audit log entries
 * - Query audit logs with filters
 * - Generate compliance reports
 * - Export audit data (GDPR, NIS2, DORA)
 *
 * Compliance: GDPR, NIS2, DORA
 * Retention: 7 years (NIS2/DORA requirement)
 * 
 * @module services/audit-log.service
 */

import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();

// ==========================================
// CONSTANTS & CONFIGURATION
// ==========================================

/**
 * Audit event categories
 * Used for organizing and filtering audit events
 */
export const EVENT_CATEGORIES = {
  AUTH: 'auth',
  DATA_ACCESS: 'data_access',
  DATA_MODIFICATION: 'data_modification',
  SYSTEM: 'system',
  SECURITY: 'security',
  COMPLIANCE: 'compliance',
};

/**
 * Audit actions
 * Standard actions tracked across all resources
 */
export const AUDIT_ACTIONS = {
  CREATE: 'create',
  READ: 'read',
  UPDATE: 'update',
  DELETE: 'delete',
  EXPORT: 'export',
  ERASE: 'erase',
  LOGIN: 'login',
  LOGOUT: 'logout',
  AUTH_SUCCESS: 'auth_success',
  AUTH_FAILURE: 'auth_failure',
  PERMISSION_DENIED: 'permission_denied',
  API_KEY_USED: 'api_key_used',
  API_KEY_REVOKED: 'api_key_revoked',
};

/**
 * Resource types tracked in audit logs
 */
export const RESOURCE_TYPES = {
  MEMORY: 'memory',
  USER: 'user',
  ORGANIZATION: 'organization',
  INTEGRATION: 'integration',
  API_KEY: 'api_key',
  SESSION: 'session',
  AUDIT_LOG: 'audit_log',
  EXPORT_REQUEST: 'export_request',
};

/**
 * Audit log configuration
 */
export const AUDIT_CONFIG = {
  retentionYears: 7,
  maxQueryLimit: 1000,
  defaultQueryLimit: 100,
  exportBatchSize: 10000,
};

// ==========================================
// TYPE DEFINITIONS (JSDoc)
// ==========================================

/**
 * @typedef {Object} AuditLogParams
 * @property {string} userId - User ID (UUID)
 * @property {string} [organizationId] - Organization ID (UUID)
 * @property {string} eventType - Event type identifier
 * @property {string} eventCategory - Event category (auth, data_access, etc.)
 * @property {string} [resourceType] - Type of resource (memory, user, etc.)
 * @property {string} [resourceId] - Resource ID (UUID)
 * @property {string} action - Action performed (create, read, update, delete)
 * @property {Object} [oldValue] - Previous state (for updates/deletes)
 * @property {Object} [newValue] - New state (for creates/updates)
 * @property {string} [ipAddress] - Client IP address
 * @property {string} [userAgent] - Client user agent
 * @property {string} [platformType] - Platform type (chatgpt, claude, etc.)
 * @property {string} [sessionId] - Session ID (UUID)
 * @property {string} [processingBasis] - GDPR processing basis
 * @property {string} [legalBasisNote] - Legal basis note
 */

/**
 * @typedef {Object} AuditLogQueryParams
 * @property {string} [userId] - Filter by user ID
 * @property {string} [organizationId] - Filter by organization ID
 * @property {string} [eventType] - Filter by event type
 * @property {string} [eventCategory] - Filter by event category
 * @property {string} [resourceType] - Filter by resource type
 * @property {string} [action] - Filter by action
 * @property {Date} [startDate] - Filter by start date
 * @property {Date} [endDate] - Filter by end date
 * @property {number} [limit] - Maximum results (default: 100)
 * @property {number} [offset] - Pagination offset (default: 0)
 */

// ==========================================
// CORE AUDIT LOGGING FUNCTIONS
// ==========================================

/**
 * Create an audit log entry
 * NIS2/DORA compliant with 7-year retention
 * 
 * @param {AuditLogParams} params - Audit log parameters
 * @returns {Promise<Object|null>} Created audit log or null on failure
 */
export async function createAuditLog(params) {
  const {
    userId,
    organizationId,
    eventType,
    eventCategory,
    resourceType,
    resourceId,
    action,
    oldValue,
    newValue,
    ipAddress,
    userAgent,
    platformType,
    sessionId,
    processingBasis,
    legalBasisNote,
  } = params;

  try {
    const auditId = uuidv4();

    const logEntry = await prisma.auditLog.create({
      data: {
        id: auditId,
        userId,
        organizationId,
        eventType,
        eventCategory,
        resourceType,
        resourceId,
        action,
        oldValue: oldValue || null,
        newValue: newValue || null,
        ipAddress,
        userAgent,
        platformType,
        sessionId,
        processingBasis,
        legalBasisNote,
      },
    });

    // Log for development/debugging (never log sensitive data in production)
    if (process.env.NODE_ENV === 'development') {
      logger.debug('Audit log created', {
        auditId,
        eventType,
        action,
        resourceType,
      });
    }

    return logEntry;
  } catch (error) {
    // Never fail the main operation due to audit logging
    logger.error('Audit logging failed', { error, params });
    return null;
  }
}

/**
 * Create audit log with automatic context extraction
 * Helper function that extracts context from Express request
 * 
 * @param {Object} options - Audit log options
 * @param {string} options.eventType - Event type
 * @param {string} [options.eventCategory] - Event category
 * @param {string} [options.action] - Action
 * @param {string} [options.resourceType] - Resource type
 * @param {string} [options.resourceId] - Resource ID
 * @param {string} options.userId - User ID
 * @param {string} [options.organizationId] - Organization ID
 * @param {Object} [options.oldValue] - Old value
 * @param {Object} [options.newValue] - New value
 * @param {Object} [options.request] - Express request object
 * @returns {Promise<Object|null>}
 */
export async function createAuditLogWithContext(options) {
  const {
    eventType,
    eventCategory = EVENT_CATEGORIES.SYSTEM,
    action = AUDIT_ACTIONS.READ,
    resourceType,
    resourceId,
    userId,
    organizationId,
    oldValue,
    newValue,
    request,
  } = options;

  // Extract context from request if provided
  const context = request ? {
    ipAddress: request.ip || request.connection?.remoteAddress,
    userAgent: request.headers?.['user-agent'],
    platformType: request.headers?.['x-platform-type'],
    sessionId: request.headers?.['x-session-id'],
  } : {};

  return createAuditLog({
    userId,
    organizationId,
    eventType,
    eventCategory,
    resourceType,
    resourceId,
    action,
    oldValue,
    newValue,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    platformType: context.platformType,
    sessionId: context.sessionId,
  });
}

/**
 * Query audit logs with filters
 * Supports pagination and date range filtering
 * 
 * @param {AuditLogQueryParams} params - Query parameters
 * @returns {Promise<Object>} Query results with pagination
 */
export async function queryAuditLogs(params) {
  const {
    userId,
    organizationId,
    eventType,
    eventCategory,
    resourceType,
    action,
    startDate,
    endDate,
    limit = AUDIT_CONFIG.defaultQueryLimit,
    offset = 0,
  } = params;

  try {
    // Build where clause
    const where = {};

    if (userId) where.userId = userId;
    if (organizationId) where.organizationId = organizationId;
    if (eventType) where.eventType = eventType;
    if (eventCategory) where.eventCategory = eventCategory;
    if (resourceType) where.resourceType = resourceType;
    if (action) where.action = action;

    // Date range filter
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    // Execute query with pagination
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: Math.min(limit, AUDIT_CONFIG.maxQueryLimit),
      }),
      prisma.auditLog.count({ where }),
    ]);

    return {
      logs,
      total,
      limit: Math.min(limit, AUDIT_CONFIG.maxQueryLimit),
      offset,
      hasMore: offset + limit < total,
    };
  } catch (error) {
    logger.error('Audit log query failed', { error, params });
    throw error;
  }
}

/**
 * Get audit log by ID
 * 
 * @param {string} auditId - Audit log ID
 * @returns {Promise<Object|null>}
 */
export async function getAuditLogById(auditId) {
  try {
    const log = await prisma.auditLog.findUnique({
      where: { id: auditId },
    });

    return log || null;
  } catch (error) {
    logger.error('Audit log retrieval failed', { auditId, error });
    throw error;
  }
}

/**
 * Get audit logs for a specific user
 * 
 * @param {string} userId - User ID
 * @param {Object} params - Query parameters
 * @returns {Promise<Object>}
 */
export async function getUserAuditLogs(userId, params = {}) {
  const { startDate, endDate, limit = 100, offset = 0 } = params;

  try {
    const { logs, total, ...rest } = await queryAuditLogs({
      userId,
      startDate,
      endDate,
      limit,
      offset,
    });

    return {
      userId,
      logs,
      total,
      ...rest,
    };
  } catch (error) {
    logger.error('User audit logs retrieval failed', { userId, error });
    throw error;
  }
}

/**
 * Get audit logs for a specific resource
 * 
 * @param {string} resourceType - Resource type (memory, user, etc.)
 * @param {string} resourceId - Resource ID
 * @param {Object} params - Query parameters
 * @returns {Promise<Object>}
 */
export async function getResourceAuditLogs(resourceType, resourceId, params = {}) {
  const { startDate, endDate, limit = 100, offset = 0 } = params;

  try {
    const { logs, total, ...rest } = await queryAuditLogs({
      resourceType,
      resourceId,
      startDate,
      endDate,
      limit,
      offset,
    });

    return {
      resourceType,
      resourceId,
      logs,
      total,
      ...rest,
    };
  } catch (error) {
    logger.error('Resource audit logs retrieval failed', { resourceType, resourceId, error });
    throw error;
  }
}

// ==========================================
// STATISTICS & REPORTING
// ==========================================

/**
 * Get audit log statistics
 * Provides summary counts and breakdowns
 * 
 * @param {Object} params - Statistics parameters
 * @param {string} [params.userId] - Filter by user
 * @param {string} [params.organizationId] - Filter by organization
 * @param {Date} [params.startDate] - Start date
 * @param {Date} [params.endDate] - End date
 * @returns {Promise<Object>} Statistics object
 */
export async function getAuditLogStats(params = {}) {
  const { userId, organizationId, startDate, endDate } = params;

  try {
    // Build where clause
    const where = {};
    if (userId) where.userId = userId;
    if (organizationId) where.organizationId = organizationId;

    // Date range filter
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    // Get counts in parallel
    const [
      total,
      byCategory,
      byAction,
      byResourceType,
      byUser,
    ] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.groupBy({
        by: ['eventCategory'],
        where,
        _count: { eventCategory: true },
      }),
      prisma.auditLog.groupBy({
        by: ['action'],
        where,
        _count: { action: true },
      }),
      prisma.auditLog.groupBy({
        by: ['resourceType'],
        where,
        _count: { resourceType: true },
      }),
      prisma.auditLog.groupBy({
        by: ['userId'],
        where,
        _count: { userId: true },
      }),
    ]);

    // Format results
    return {
      total,
      byCategory: byCategory.reduce((acc, item) => {
        acc[item.eventCategory] = item._count.eventCategory;
        return acc;
      }, {}),
      byAction: byAction.reduce((acc, item) => {
        acc[item.action] = item._count.action;
        return acc;
      }, {}),
      byResourceType: byResourceType.reduce((acc, item) => {
        if (item.resourceType) {
          acc[item.resourceType] = item._count.resourceType;
        }
        return acc;
      }, {}),
      byUser: byUser.reduce((acc, item) => {
        if (item.userId) {
          acc[item.userId] = item._count.userId;
        }
        return acc;
      }, {}),
      period: {
        start: startDate?.toISOString() || null,
        end: endDate?.toISOString() || null,
      },
    };
  } catch (error) {
    logger.error('Audit log statistics generation failed', { error, params });
    throw error;
  }
}

/**
 * Get compliance report
 * Generates reports for GDPR, NIS2, DORA compliance
 * 
 * @param {Object} params - Report parameters
 * @param {string} params.organizationId - Organization ID
 * @param {Date} params.startDate - Start date
 * @param {Date} params.endDate - End date
 * @param {string} [params.reportType] - Report type (standard, nis2, dora, gdpr)
 * @returns {Promise<Object>} Compliance report
 */
export async function getComplianceReport(params) {
  const { organizationId, startDate, endDate, reportType = 'standard' } = params;

  try {
    const { logs } = await queryAuditLogs({
      organizationId,
      startDate,
      endDate,
      limit: AUDIT_CONFIG.exportBatchSize,
    });

    // Generate report based on type
    let report;
    switch (reportType) {
      case 'nis2':
        report = generateNIS2Report(logs, startDate, endDate);
        break;
      case 'dora':
        report = generateDORAReport(logs, startDate, endDate);
        break;
      case 'gdpr':
        report = generateGDPRReport(logs, startDate, endDate);
        break;
      default:
        report = generateStandardReport(logs, startDate, endDate);
    }

    return {
      reportType,
      organizationId,
      period: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      ...report,
    };
  } catch (error) {
    logger.error('Compliance report generation failed', { error, params });
    throw error;
  }
}

/**
 * Generate standard report
 */
function generateStandardReport(logs, startDate, endDate) {
  const byCategory = {};
  const byAction = {};
  const byUser = {};

  logs.forEach(log => {
    if (!byCategory[log.eventCategory]) {
      byCategory[log.eventCategory] = 0;
    }
    byCategory[log.eventCategory]++;

    if (!byAction[log.action]) {
      byAction[log.action] = 0;
    }
    byAction[log.action]++;

    if (log.userId) {
      if (!byUser[log.userId]) {
        byUser[log.userId] = 0;
      }
      byUser[log.userId]++;
    }
  });

  return {
    summary: {
      totalEvents: logs.length,
      uniqueUsers: Object.keys(byUser).length,
    },
    breakdown: {
      byCategory,
      byAction,
    },
    topUsers: Object.entries(byUser)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([userId, eventCount]) => ({ userId, eventCount })),
  };
}

/**
 * Generate NIS2 report
 */
function generateNIS2Report(logs, startDate, endDate) {
  const securityEvents = logs.filter(log =>
    log.eventCategory === EVENT_CATEGORIES.SECURITY ||
    log.action === AUDIT_ACTIONS.PERMISSION_DENIED
  );

  const authEvents = logs.filter(log =>
    log.eventCategory === EVENT_CATEGORIES.AUTH
  );

  return {
    summary: {
      totalEvents: logs.length,
      securityEvents: securityEvents.length,
      authEvents: authEvents.length,
    },
    securityEvents: securityEvents.slice(0, 100).map(e => ({
      id: e.id,
      eventType: e.eventType,
      action: e.action,
      ipAddress: e.ipAddress,
      createdAt: e.createdAt.toISOString(),
    })),
    recommendations: securityEvents.length > 10
      ? ['Review security events - high volume detected']
      : ['No immediate action required'],
  };
}

/**
 * Generate DORA report
 */
function generateDORAReport(logs, startDate, endDate) {
  const systemEvents = logs.filter(log =>
    log.eventCategory === EVENT_CATEGORIES.SYSTEM ||
    log.eventType?.includes('system')
  );

  const syncEvents = logs.filter(log =>
    log.eventType?.includes('sync')
  );

  return {
    summary: {
      totalEvents: logs.length,
      systemEvents: systemEvents.length,
      syncEvents: syncEvents.length,
    },
    systemEvents: systemEvents.slice(0, 100).map(e => ({
      id: e.id,
      eventType: e.eventType,
      action: e.action,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

/**
 * Generate GDPR report
 */
function generateGDPRReport(logs, startDate, endDate) {
  const exportEvents = logs.filter(log =>
    log.action === AUDIT_ACTIONS.EXPORT
  );

  const eraseEvents = logs.filter(log =>
    log.action === AUDIT_ACTIONS.ERASE
  );

  return {
    summary: {
      totalEvents: logs.length,
      exportEvents: exportEvents.length,
      eraseEvents: eraseEvents.length,
    },
    exportEvents: exportEvents.slice(0, 100).map(e => ({
      id: e.id,
      userId: e.userId,
      format: e.newValue?.format,
      createdAt: e.createdAt.toISOString(),
    })),
    eraseEvents: eraseEvents.slice(0, 100).map(e => ({
      id: e.id,
      userId: e.userId,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

// ==========================================
// SPECIALIZED AUDIT LOGGING FUNCTIONS
// ==========================================

/**
 * Log authentication event
 * 
 * @param {Object} params - Auth event parameters
 * @param {string} params.userId - User ID
 * @param {string} params.eventType - auth_success, auth_failure, login, logout
 * @param {Object} params.request - Express request
 * @param {Object} [params.details] - Additional details
 * @returns {Promise<Object|null>}
 */
export async function logAuthEvent(params) {
  const { userId, eventType, request, details = {} } = params;

  return createAuditLog({
    userId,
    eventType,
    eventCategory: EVENT_CATEGORIES.AUTH,
    action: eventType.includes('failure') ? AUDIT_ACTIONS.AUTH_FAILURE : AUDIT_ACTIONS.AUTH_SUCCESS,
    resourceType: 'authentication',
    ipAddress: request.ip,
    userAgent: request.headers?.['user-agent'],
    sessionId: request.headers?.['x-session-id'],
    newValue: details,
  });
}

/**
 * Log memory operation
 * 
 * @param {Object} params - Memory operation parameters
 * @param {string} params.userId - User ID
 * @param {string} params.memoryId - Memory ID
 * @param {string} params.action - create, read, update, delete
 * @param {Object} [params.oldValue] - Old memory state
 * @param {Object} [params.newValue] - New memory state
 * @param {Object} params.request - Express request
 * @returns {Promise<Object|null>}
 */
export async function logMemoryOperation(params) {
  const { userId, memoryId, action, oldValue, newValue, request } = params;

  return createAuditLog({
    userId,
    eventType: `memory_${action}`,
    eventCategory: action === 'read'
      ? EVENT_CATEGORIES.DATA_ACCESS
      : EVENT_CATEGORIES.DATA_MODIFICATION,
    action,
    resourceType: RESOURCE_TYPES.MEMORY,
    resourceId: memoryId,
    ipAddress: request.ip,
    userAgent: request.headers?.['user-agent'],
    platformType: request.headers?.['x-platform-type'],
    sessionId: request.headers?.['x-session-id'],
    oldValue,
    newValue,
  });
}

/**
 * Log API key operation
 * 
 * @param {Object} params - API key operation parameters
 * @param {string} params.userId - User ID
 * @param {string} params.keyId - API key ID
 * @param {string} params.action - create, read, update, delete, api_key_used, api_key_revoked
 * @param {Object} [params.details] - Additional details
 * @param {Object} params.request - Express request
 * @returns {Promise<Object|null>}
 */
export async function logApiKeyOperation(params) {
  const { userId, keyId, action, details = {}, request } = params;

  return createAuditLog({
    userId,
    eventType: `api_key_${action}`,
    eventCategory: EVENT_CATEGORIES.SECURITY,
    action,
    resourceType: RESOURCE_TYPES.API_KEY,
    resourceId: keyId,
    ipAddress: request.ip,
    userAgent: request.headers?.['user-agent'],
    newValue: details,
  });
}

/**
 * Log data export/erasure request
 * 
 * @param {Object} params - Export/erasure parameters
 * @param {string} params.userId - User ID
 * @param {string} params.action - export or erase
 * @param {string} [params.requestId] - Export/erasure request ID
 * @param {Object} [params.details] - Additional details
 * @param {Object} params.request - Express request
 * @returns {Promise<Object|null>}
 */
export async function logDataRequest(params) {
  const { userId, action, requestId, details = {}, request } = params;

  return createAuditLog({
    userId,
    eventType: `${action}_request`,
    eventCategory: EVENT_CATEGORIES.COMPLIANCE,
    action,
    resourceType: RESOURCE_TYPES.EXPORT_REQUEST,
    resourceId: requestId,
    ipAddress: request.ip,
    userAgent: request.headers?.['user-agent'],
    newValue: details,
    processingBasis: 'consent',
    legalBasisNote: 'GDPR Article 15/17 - User initiated request',
  });
}

// ==========================================
// EXPORT SERVICE MODULE
// ==========================================

export default {
  // Core functions
  createAuditLog,
  createAuditLogWithContext,
  queryAuditLogs,
  getAuditLogById,
  getUserAuditLogs,
  getResourceAuditLogs,

  // Statistics & reporting
  getAuditLogStats,
  getComplianceReport,

  // Specialized logging
  logAuthEvent,
  logMemoryOperation,
  logApiKeyOperation,
  logDataRequest,

  // Constants
  EVENT_CATEGORIES,
  AUDIT_ACTIONS,
  RESOURCE_TYPES,
  AUDIT_CONFIG,
};

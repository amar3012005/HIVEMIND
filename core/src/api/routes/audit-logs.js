/**
 * Audit Logs API Routes
 * HIVE-MIND Cross-Platform Context Sync
 *
 * RESTful endpoints for audit log access and compliance reporting
 * - GET /api/audit-logs - List audit events
 * - GET /api/audit-logs/:id - Get event details
 * - GET /api/audit-logs/stats - Get statistics
 * - GET /api/audit-logs/compliance - Get compliance report
 *
 * All endpoints require JWT authentication (ZITADEL OIDC)
 * Admin scope required for organization-level audit logs
 *
 * Compliance: GDPR, NIS2, DORA
 * Retention: 7 years (NIS2/DORA requirement)
 *
 * @module api/routes/audit-logs
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as auditLogService from '../../services/audit-log.service.js';

const router = Router();

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Generate a unique request ID for tracing
 * @returns {string} UUID request ID
 */
function generateRequestId() {
  return uuidv4();
}

/**
 * Extract client IP from request
 * @param {Object} req - Express request object
 * @returns {string|null} Client IP address
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.connection?.remoteAddress
    || null;
}

/**
 * Standard success response
 * @param {Object} res - Express response object
 * @param {number} statusCode - HTTP status code
 * @param {Object} data - Response data
 * @param {string} requestId - Request ID for tracing
 */
function sendSuccess(res, statusCode, data, requestId) {
  res.status(statusCode).json({
    success: true,
    data,
    requestId,
  });
}

/**
 * Standard error response
 * @param {Object} res - Express response object
 * @param {number} statusCode - HTTP status code
 * @param {string} error - Error code
 * @param {string} message - Human-readable message
 * @param {Object|null} details - Additional error details
 * @param {string} requestId - Request ID for tracing
 */
function sendError(res, statusCode, error, message, details = null, requestId) {
  res.status(statusCode).json({
    success: false,
    error,
    message,
    details,
    requestId,
  });
}

/**
 * Parse ISO date string safely
 * @param {string} dateStr - ISO date string
 * @returns {Date|null}
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  return date;
}

// ==========================================
// ROUTES
// ==========================================

/**
 * GET /api/audit-logs
 * List audit log events with filtering and pagination
 *
 * @auth JWT required (ZITADEL OIDC)
 * @scope read, admin
 *
 * @query {string} [userId] - Filter by user ID
 * @query {string} [eventType] - Filter by event type
 * @query {string} [eventCategory] - Filter by category (auth, data_access, etc.)
 * @query {string} [resourceType] - Filter by resource type (memory, user, etc.)
 * @query {string} [action] - Filter by action (create, read, update, delete)
 * @query {string} [startDate] - Filter by start date (ISO 8601)
 * @query {string} [endDate] - Filter by end date (ISO 8601)
 * @query {number} [limit=100] - Maximum results (max: 1000)
 * @query {number} [offset=0] - Pagination offset
 *
 * @response {200} List of audit logs with pagination
 * @response {401} Unauthorized
 * @response {403} Insufficient scope
 */
router.get('/', async (req, res) => {
  const requestId = generateRequestId();

  try {
    // Extract user context from JWT
    const user = req.user;
    if (!user || !user.id) {
      return sendError(res, 401, 'UNAUTHORIZED', 'JWT authentication required', null, requestId);
    }

    // Check scope
    if (!user.scopes?.includes('admin') && !user.scopes?.includes('read')) {
      return sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Requires read or admin scope', null, requestId);
    }

    // Parse query parameters
    const {
      userId,
      eventType,
      eventCategory,
      resourceType,
      action,
      startDate: startDateStr,
      endDate: endDateStr,
    } = req.query;

    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const offset = parseInt(req.query.offset) || 0;

    // Enforce multi-tenant isolation: users can only see their own logs
    // Admin users can see organization logs
    const effectiveUserId = user.scopes?.includes('admin') ? userId : user.id;
    const organizationId = user.scopes?.includes('admin') ? user.organizationId : null;

    // Parse dates
    const startDate = parseDate(startDateStr);
    const endDate = parseDate(endDateStr);

    // Query audit logs
    const result = await auditLogService.queryAuditLogs({
      userId: effectiveUserId,
      organizationId,
      eventType,
      eventCategory,
      resourceType,
      action,
      startDate,
      endDate,
      limit,
      offset,
    });

    return sendSuccess(res, 200, result, requestId);

  } catch (error) {
    console.error('[AUDIT_LOGS] Error listing audit logs:', {
      requestId,
      error: error.message,
      stack: error.stack,
    });

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list audit logs', null, requestId);
  }
});

/**
 * GET /api/audit-logs/:id
 * Get details of a specific audit log event
 *
 * @auth JWT required (ZITADEL OIDC)
 * @scope read, admin
 *
 * @param {string} id - Audit log ID
 *
 * @response {200} Audit log details
 * @response {404} Not found
 * @response {401} Unauthorized
 * @response {403} Insufficient scope
 */
router.get('/:id', async (req, res) => {
  const requestId = generateRequestId();

  try {
    // Extract user context from JWT
    const user = req.user;
    if (!user || !user.id) {
      return sendError(res, 401, 'UNAUTHORIZED', 'JWT authentication required', null, requestId);
    }

    // Check scope
    if (!user.scopes?.includes('admin') && !user.scopes?.includes('read')) {
      return sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Requires read or admin scope', null, requestId);
    }

    const auditId = req.params.id;

    // Get audit log
    const auditLog = await auditLogService.getAuditLogById(auditId);

    if (!auditLog) {
      return sendError(res, 404, 'AUDIT_LOG_NOT_FOUND', 'Audit log not found', null, requestId);
    }

    // Enforce multi-tenant isolation
    if (!user.scopes?.includes('admin') && auditLog.userId !== user.id) {
      return sendError(res, 403, 'FORBIDDEN', 'Access denied to this audit log', null, requestId);
    }

    return sendSuccess(res, 200, auditLog, requestId);

  } catch (error) {
    console.error('[AUDIT_LOGS] Error getting audit log:', {
      requestId,
      error: error.message,
    });

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get audit log', null, requestId);
  }
});

/**
 * GET /api/audit-logs/stats
 * Get audit log statistics
 *
 * @auth JWT required (ZITADEL OIDC)
 * @scope read, admin
 *
 * @query {string} [startDate] - Filter by start date (ISO 8601)
 * @query {string} [endDate] - Filter by end date (ISO 8601)
 *
 * @response {200} Statistics object with breakdowns
 * @response {401} Unauthorized
 * @response {403} Insufficient scope
 */
router.get('/stats', async (req, res) => {
  const requestId = generateRequestId();

  try {
    // Extract user context from JWT
    const user = req.user;
    if (!user || !user.id) {
      return sendError(res, 401, 'UNAUTHORIZED', 'JWT authentication required', null, requestId);
    }

    // Check scope
    if (!user.scopes?.includes('admin') && !user.scopes?.includes('read')) {
      return sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Requires read or admin scope', null, requestId);
    }

    // Parse query parameters
    const { startDate: startDateStr, endDate: endDateStr } = req.query;
    const startDate = parseDate(startDateStr);
    const endDate = parseDate(endDateStr);

    // Get statistics
    const stats = await auditLogService.getAuditLogStats({
      userId: user.scopes?.includes('admin') ? null : user.id,
      organizationId: user.scopes?.includes('admin') ? user.organizationId : null,
      startDate,
      endDate,
    });

    return sendSuccess(res, 200, stats, requestId);

  } catch (error) {
    console.error('[AUDIT_LOGS] Error getting audit log stats:', {
      requestId,
      error: error.message,
    });

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get audit log statistics', null, requestId);
  }
});

/**
 * GET /api/audit-logs/compliance
 * Get compliance report for regulatory submission
 *
 * @auth JWT required (ZITADEL OIDC)
 * @scope admin
 *
 * @query {string} [reportType=standard] - Report type (standard, nis2, dora, gdpr)
 * @query {string} [startDate] - Start date (ISO 8601, default: 90 days ago)
 * @query {string} [endDate] - End date (ISO 8601, default: now)
 *
 * @response {200} Compliance report
 * @response {401} Unauthorized
 * @response {403} Insufficient scope
 */
router.get('/compliance', async (req, res) => {
  const requestId = generateRequestId();

  try {
    // Extract user context from JWT
    const user = req.user;
    if (!user || !user.id) {
      return sendError(res, 401, 'UNAUTHORIZED', 'JWT authentication required', null, requestId);
    }

    // Check scope - admin only for compliance reports
    if (!user.scopes?.includes('admin')) {
      return sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Requires admin scope', null, requestId);
    }

    // Parse query parameters
    const reportType = req.query.reportType || 'standard';
    const { startDate: startDateStr, endDate: endDateStr } = req.query;

    // Default to last 90 days if not specified
    const endDate = parseDate(endDateStr) || new Date();
    const startDate = parseDate(startDateStr) || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    // Validate report type
    const validReportTypes = ['standard', 'nis2', 'dora', 'gdpr'];
    if (!validReportTypes.includes(reportType.toLowerCase())) {
      return sendError(
        res,
        400,
        'INVALID_REPORT_TYPE',
        `Invalid report type. Must be one of: ${validReportTypes.join(', ')}`,
        null,
        requestId
      );
    }

    // Get compliance report
    const report = await auditLogService.getComplianceReport({
      organizationId: user.organizationId,
      startDate,
      endDate,
      reportType: reportType.toLowerCase(),
    });

    return sendSuccess(res, 200, report, requestId);

  } catch (error) {
    console.error('[AUDIT_LOGS] Error getting compliance report:', {
      requestId,
      error: error.message,
      stack: error.stack,
    });

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get compliance report', null, requestId);
  }
});

/**
 * GET /api/audit-logs/user/:userId
 * Get audit logs for a specific user
 *
 * @auth JWT required (ZITADEL OIDC)
 * @scope admin
 *
 * @param {string} userId - User ID
 * @query {string} [startDate] - Filter by start date
 * @query {string} [endDate] - Filter by end date
 * @query {number} [limit=100] - Maximum results
 * @query {number} [offset=0] - Pagination offset
 *
 * @response {200} User's audit logs
 * @response {401} Unauthorized
 * @response {403} Insufficient scope
 */
router.get('/user/:userId', async (req, res) => {
  const requestId = generateRequestId();

  try {
    // Extract user context from JWT
    const user = req.user;
    if (!user || !user.id) {
      return sendError(res, 401, 'UNAUTHORIZED', 'JWT authentication required', null, requestId);
    }

    // Check scope - admin only for viewing other users' logs
    if (!user.scopes?.includes('admin')) {
      return sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Requires admin scope', null, requestId);
    }

    const targetUserId = req.params.userId;
    const { startDate: startDateStr, endDate: endDateStr } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const offset = parseInt(req.query.offset) || 0;

    const startDate = parseDate(startDateStr);
    const endDate = parseDate(endDateStr);

    // Get user's audit logs
    const result = await auditLogService.getUserAuditLogs(targetUserId, {
      startDate,
      endDate,
      limit,
      offset,
    });

    return sendSuccess(res, 200, result, requestId);

  } catch (error) {
    console.error('[AUDIT_LOGS] Error getting user audit logs:', {
      requestId,
      error: error.message,
    });

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get user audit logs', null, requestId);
  }
});

/**
 * GET /api/audit-logs/resource/:resourceType/:resourceId
 * Get audit logs for a specific resource
 *
 * @auth JWT required (ZITADEL OIDC)
 * @scope read, admin
 *
 * @param {string} resourceType - Resource type (memory, user, api_key, etc.)
 * @param {string} resourceId - Resource ID
 * @query {string} [startDate] - Filter by start date
 * @query {string} [endDate] - Filter by end date
 * @query {number} [limit=100] - Maximum results
 * @query {number} [offset=0] - Pagination offset
 *
 * @response {200} Resource's audit trail
 * @response {401} Unauthorized
 * @response {403} Insufficient scope
 */
router.get('/resource/:resourceType/:resourceId', async (req, res) => {
  const requestId = generateRequestId();

  try {
    // Extract user context from JWT
    const user = req.user;
    if (!user || !user.id) {
      return sendError(res, 401, 'UNAUTHORIZED', 'JWT authentication required', null, requestId);
    }

    // Check scope
    if (!user.scopes?.includes('admin') && !user.scopes?.includes('read')) {
      return sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Requires read or admin scope', null, requestId);
    }

    const resourceType = req.params.resourceType;
    const resourceId = req.params.resourceId;
    const { startDate: startDateStr, endDate: endDateStr } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const offset = parseInt(req.query.offset) || 0;

    const startDate = parseDate(startDateStr);
    const endDate = parseDate(endDateStr);

    // Get resource audit logs
    const result = await auditLogService.getResourceAuditLogs(resourceType, resourceId, {
      startDate,
      endDate,
      limit,
      offset,
    });

    return sendSuccess(res, 200, result, requestId);

  } catch (error) {
    console.error('[AUDIT_LOGS] Error getting resource audit logs:', {
      requestId,
      error: error.message,
    });

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get resource audit logs', null, requestId);
  }
});

export default router;

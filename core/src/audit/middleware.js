/**
 * Audit Logging Middleware
 * Automatically logs all requests for NIS2/DORA compliance
 *
 * Features:
 * - Automatic request/response logging
 * - Context extraction from Express requests
 * - Performance metrics tracking
 * - Error logging with full context
 */

import { auditLog, EVENT_CATEGORIES, AUDIT_ACTIONS } from './logger.js';

/**
 * Audit middleware options
 */
const AUDIT_OPTIONS = {
  skipPaths: ['/health', '/metrics', '/favicon.ico'],
  skipMethods: ['OPTIONS'],
  includeBody: false,
};

/**
 * Audit middleware factory
 */
export function auditMiddleware(options = {}) {
  const {
    skipPaths = AUDIT_OPTIONS.skipPaths,
    skipMethods = AUDIT_OPTIONS.skipMethods,
    includeBody = AUDIT_OPTIONS.includeBody,
    eventType,
    eventCategory = EVENT_CATEGORIES.SYSTEM,
    action = AUDIT_ACTIONS.SYSTEM_EVENT,
    resourceType,
    getResourceId,
  } = options;

  return async (req, res, next) => {
    // Skip if path matches
    if (skipPaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    // Skip if method matches
    if (skipMethods.includes(req.method)) {
      return next();
    }

    const startTime = Date.now();

    // Capture response for audit
    const originalJson = res.json.bind(res);
    let responseBody;

    res.json = function(body) {
      responseBody = body;
      return originalJson(body);
    };

    try {
      // Log before request
      await auditLog({
        eventType: `${eventType || req.path}_start`,
        eventCategory: eventCategory,
        action: action,
        resourceType: resourceType || req.path.split('/')[1],
        resourceId: getResourceId?.(req),
        userId: req.user?.id,
        organizationId: req.user?.organizationId,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        platformType: req.headers['x-platform-type'],
        sessionId: req.headers['x-session-id'],
        oldValue: null,
        newValue: includeBody ? req.body : null,
      });

      await next();

      const latency = Date.now() - startTime;

      // Log after successful request
      await auditLog({
        eventType: `${eventType || req.path}_complete`,
        eventCategory: eventCategory,
        action: action,
        resourceType: resourceType || req.path.split('/')[1],
        resourceId: getResourceId?.(req),
        userId: req.user?.id,
        organizationId: req.user?.organizationId,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        platformType: req.headers['x-platform-type'],
        sessionId: req.headers['x-session-id'],
        oldValue: null,
        newValue: includeBody ? responseBody : null,
      });

      // Add latency header
      res.setHeader('X-Request-Latency', latency);
    } catch (error) {
      // Log failed request
      await auditLog({
        eventType: `${eventType || req.path}_error`,
        eventCategory: EVENT_CATEGORIES.SECURITY,
        action: AUDIT_ACTIONS.SYSTEM_EVENT,
        resourceType: resourceType || req.path.split('/')[1],
        resourceId: getResourceId?.(req),
        userId: req.user?.id,
        organizationId: req.user?.organizationId,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        platformType: req.headers['x-platform-type'],
        sessionId: req.headers['x-session-id'],
        oldValue: null,
        newValue: {
          error: error.message,
          stack: error.stack,
        },
      });

      throw error;
    }
  };
}

/**
 * Authentication audit middleware
 */
export function authAuditMiddleware(req, res, next) {
  const startTime = Date.now();

  return async (req, res, next) => {
    try {
      await next();

      const latency = Date.now() - startTime;

      // Log authentication event
      await auditLog({
        eventType: 'authentication',
        eventCategory: EVENT_CATEGORIES.AUTH,
        action: AUDIT_ACTIONS.AUTH_SUCCESS,
        resourceType: 'authentication',
        userId: req.user?.id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        sessionId: req.headers['x-session-id'],
        newValue: {
          method: req.headers['authorization'] ? 'bearer' : 'cookie',
          latencyMs: latency,
        },
      });
    } catch (error) {
      await auditLog({
        eventType: 'authentication_failure',
        eventCategory: EVENT_CATEGORIES.AUTH,
        action: AUDIT_ACTIONS.AUTH_FAILURE,
        resourceType: 'authentication',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        oldValue: {
          error: error.message,
        },
      });

      throw error;
    }
  };
}

/**
 * Data access audit middleware
 */
export function dataAccessAuditMiddleware(options = {}) {
  return auditMiddleware({
    ...options,
    eventCategory: EVENT_CATEGORIES.DATA_ACCESS,
    action: AUDIT_ACTIONS.READ,
  });
}

/**
 * Data modification audit middleware
 */
export function dataModificationAuditMiddleware(options = {}) {
  return auditMiddleware({
    ...options,
    eventCategory: EVENT_CATEGORIES.DATA_MODIFICATION,
    action: AUDIT_ACTIONS.UPDATE,
  });
}

/**
 * Security event audit middleware
 */
export function securityAuditMiddleware(options = {}) {
  return auditMiddleware({
    ...options,
    eventCategory: EVENT_CATEGORIES.SECURITY,
    action: AUDIT_ACTIONS.SYSTEM_EVENT,
  });
}

/**
 * Export audit middleware
 */
export function exportAuditMiddleware(options = {}) {
  return auditMiddleware({
    ...options,
    eventCategory: EVENT_CATEGORIES.COMPLIANCE,
    action: AUDIT_ACTIONS.EXPORT,
  });
}

/**
 * Erasure audit middleware
 */
export function erasureAuditMiddleware(options = {}) {
  return auditMiddleware({
    ...options,
    eventCategory: EVENT_CATEGORIES.COMPLIANCE,
    action: AUDIT_ACTIONS.ERASE,
  });
}

/**
 * Request logging middleware (simplified)
 */
export function requestLogger(req, res, next) {
  const startTime = Date.now();

  res.on('finish', () => {
    const latency = Date.now() - startTime;
    const logData = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      latencyMs: latency,
      userId: req.user?.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    };

    console.log(JSON.stringify({
      type: 'request',
      timestamp: new Date().toISOString(),
      ...logData,
    }));
  });

  next();
}

/**
 * Error logging middleware
 */
export function errorLogger(err, req, res, next) {
  const logData = {
    type: 'error',
    timestamp: new Date().toISOString(),
    message: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    userId: req.user?.id,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    body: req.body,
    query: req.query,
  };

  console.error(JSON.stringify(logData));

  next(err);
}

/**
 * Audit log for specific operations
 */
export async function logOperation(params) {
  const {
    operation,
    userId,
    organizationId,
    resourceType,
    resourceId,
    details = {},
    request,
  } = params;

  const context = request ? {
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
    sessionId: request.headers['x-session-id'],
  } : {};

  return auditLog({
    eventType: `operation_${operation}`,
    eventCategory: EVENT_CATEGORIES.SYSTEM,
    action: AUDIT_ACTIONS.SYSTEM_EVENT,
    resourceType,
    resourceId,
    userId,
    organizationId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    sessionId: context.sessionId,
    newValue: details,
  });
}

/**
 * Log authentication success
 */
export async function logAuthSuccess(userId, request, details = {}) {
  return auditLog({
    eventType: 'auth_success',
    eventCategory: EVENT_CATEGORIES.AUTH,
    action: AUDIT_ACTIONS.AUTH_SUCCESS,
    resourceType: 'authentication',
    userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
    sessionId: request.headers['x-session-id'],
    newValue: details,
  });
}

/**
 * Log authentication failure
 */
export async function logAuthFailure(ipAddress, request, details = {}) {
  return auditLog({
    eventType: 'auth_failure',
    eventCategory: EVENT_CATEGORIES.AUTH,
    action: AUDIT_ACTIONS.AUTH_FAILURE,
    resourceType: 'authentication',
    ipAddress,
    userAgent: request.headers['user-agent'],
    oldValue: details,
  });
}

/**
 * Log data access
 */
export async function logDataAccess(userId, resourceType, resourceId, request) {
  return auditLog({
    eventType: 'data_access',
    eventCategory: EVENT_CATEGORIES.DATA_ACCESS,
    action: AUDIT_ACTIONS.READ,
    resourceType,
    resourceId,
    userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
    sessionId: request.headers['x-session-id'],
  });
}

/**
 * Log data modification
 */
export async function logDataModification(userId, resourceType, resourceId, action, request, oldValue, newValue) {
  return auditLog({
    eventType: 'data_modification',
    eventCategory: EVENT_CATEGORIES.DATA_MODIFICATION,
    action,
    resourceType,
    resourceId,
    userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
    sessionId: request.headers['x-session-id'],
    oldValue,
    newValue,
  });
}

/**
 * Log security event
 */
export async function logSecurityEvent(userId, eventType, request, details = {}) {
  return auditLog({
    eventType,
    eventCategory: EVENT_CATEGORIES.SECURITY,
    action: AUDIT_ACTIONS.SYSTEM_EVENT,
    resourceType: 'security',
    userId,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
    sessionId: request.headers['x-session-id'],
    newValue: details,
  });
}

export default {
  auditMiddleware,
  authAuditMiddleware,
  dataAccessAuditMiddleware,
  dataModificationAuditMiddleware,
  securityAuditMiddleware,
  exportAuditMiddleware,
  erasureAuditMiddleware,
  requestLogger,
  errorLogger,
  logOperation,
  logAuthSuccess,
  logAuthFailure,
  logDataAccess,
  logDataModification,
  logSecurityEvent,
};

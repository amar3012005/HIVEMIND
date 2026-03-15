/**
 * Authentication Middleware with Audit Logging
 * HIVE-MIND Cross-Platform Context Sync
 *
 * JWT authentication middleware with ZITADEL OIDC integration
 * Audit logging for all auth events (NIS2/DORA compliance)
 * - login, logout, api_key_used, api_key_revoked
 *
 * Compliance: GDPR, NIS2, DORA
 * 
 * @module auth/middleware
 */

import { v4 as uuidv4 } from 'uuid';
import * as auditLogService from '../services/audit-log.service.js';
import { logger } from '../utils/logger.js';

// ==========================================
// CONFIGURATION
// ==========================================

const AUTH_CONFIG = {
  tokenExpiryLeeway: 60, // seconds
  requiredClaims: ['sub', 'email', 'iat', 'exp'],
};

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Extract client IP from request
 * @param {Object} req - Express request object
 * @returns {string|null}
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.connection?.remoteAddress
    || null;
}

/**
 * Extract user agent from request
 * @param {Object} req - Express request object
 * @returns {string|null}
 */
function getUserAgent(req) {
  return req.headers['user-agent'] || null;
}

/**
 * Extract session ID from request headers
 * @param {Object} req - Express request object
 * @returns {string|null}
 */
function getSessionId(req) {
  return req.headers['x-session-id'] || null;
}

/**
 * Extract platform type from request headers
 * @param {Object} req - Express request object
 * @returns {string|null}
 */
function getPlatformType(req) {
  return req.headers['x-platform-type'] || null;
}

// ==========================================
// AUTHENTICATION MIDDLEWARE
// ==========================================

/**
 * JWT Authentication Middleware
 * Validates JWT tokens from ZITADEL OIDC
 * 
 * @param {Object} options - Middleware options
 * @param {Function} options.validateToken - Token validation function
 * @param {boolean} [options.optional=false] - Make auth optional
 * @returns {Function} Express middleware
 */
export function jwtAuthMiddleware(options = {}) {
  const { validateToken, optional = false } = options;

  return async (req, res, next) => {
    const requestId = req.headers['x-request-id'] || uuidv4();
    const startTime = Date.now();

    try {
      // Extract authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        if (optional) {
          req.user = null;
          return next();
        }
        
        // Audit log: auth failure - missing token
        await auditLogService.logAuthEvent({
          eventType: 'auth_failure',
          userId: null,
          request: req,
          details: {
            reason: 'Missing authorization header',
            ipAddress: getClientIp(req),
          },
        });

        return res.status(401).json({
          success: false,
          error: 'UNAUTHORIZED',
          message: 'JWT authentication required',
          requestId,
        });
      }

      const token = authHeader.substring(7);

      // Validate token
      let decoded;
      try {
        decoded = await validateToken(token);
      } catch (error) {
        // Audit log: auth failure - invalid token
        await auditLogService.logAuthEvent({
          eventType: 'auth_failure',
          userId: null,
          request: req,
          details: {
            reason: 'Invalid token',
            error: error.message,
            ipAddress: getClientIp(req),
          },
        });

        return res.status(401).json({
          success: false,
          error: 'UNAUTHORIZED',
          message: error.message || 'Invalid token',
          requestId,
        });
      }

      // Check required claims
      for (const claim of AUTH_CONFIG.requiredClaims) {
        if (!decoded[claim]) {
          await auditLogService.logAuthEvent({
            eventType: 'auth_failure',
            userId: null,
            request: req,
            details: {
              reason: `Missing required claim: ${claim}`,
              ipAddress: getClientIp(req),
            },
          });

          return res.status(401).json({
            success: false,
            error: 'UNAUTHORIZED',
            message: 'Invalid token structure',
            requestId,
          });
        }
      }

      // Check token expiration
      const now = Math.floor(Date.now() / 1000);
      if (decoded.exp && decoded.exp < now - AUTH_CONFIG.tokenExpiryLeeway) {
        // Audit log: auth failure - token expired
        await auditLogService.logAuthEvent({
          eventType: 'auth_failure',
          userId: decoded.sub,
          request: req,
          details: {
            reason: 'Token expired',
            expiredAt: new Date(decoded.exp * 1000).toISOString(),
            ipAddress: getClientIp(req),
          },
        });

        return res.status(401).json({
          success: false,
          error: 'UNAUTHORIZED',
          message: 'Token expired',
          requestId,
        });
      }

      // Extract user context from token
      req.user = {
        id: decoded.sub,
        email: decoded.email,
        organizationId: decoded.organizationId || decoded.org_id,
        roles: decoded.roles || [],
        scopes: decoded.scopes || ['read', 'write'],
        tokenClaims: decoded,
      };

      // Audit log: auth success
      await auditLogService.logAuthEvent({
        eventType: 'auth_success',
        userId: req.user.id,
        request: req,
        details: {
          email: req.user.email,
          organizationId: req.user.organizationId,
          latencyMs: Date.now() - startTime,
        },
      });

      // Add request ID to headers for tracing
      res.setHeader('X-Request-ID', requestId);

      next();

    } catch (error) {
      logger.error('Auth middleware error', { requestId, error });

      // Audit log: auth error
      await auditLogService.logAuthEvent({
        eventType: 'auth_failure',
        userId: null,
        request: req,
        details: {
          reason: 'Authentication middleware error',
          error: error.message,
          ipAddress: getClientIp(req),
        },
      });

      return res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Authentication failed',
        requestId,
      });
    }
  };
}

/**
 * API Key Authentication Middleware
 * Validates API keys for server-to-server authentication
 * 
 * @param {Function} options.validateApiKey - API key validation function
 * @param {boolean} [options.optional=false] - Make auth optional
 * @returns {Function} Express middleware
 */
export function apiKeyAuthMiddleware(options = {}) {
  const { validateApiKey, optional = false } = options;

  return async (req, res, next) => {
    const requestId = req.headers['x-request-id'] || uuidv4();
    const startTime = Date.now();

    try {
      // Extract API key from header
      const apiKey = req.headers['x-api-key'];
      if (!apiKey) {
        if (optional) {
          req.user = null;
          return next();
        }

        // Audit log: api_key_used failure - missing key
        await auditLogService.createAuditLogWithContext({
          eventType: 'api_key_used',
          eventCategory: auditLogService.EVENT_CATEGORIES.SECURITY,
          action: auditLogService.AUDIT_ACTIONS.PERMISSION_DENIED,
          resourceType: auditLogService.RESOURCE_TYPES.API_KEY,
          userId: null,
          newValue: {
            reason: 'Missing API key',
            ipAddress: getClientIp(req),
          },
          request: req,
        });

        return res.status(401).json({
          success: false,
          error: 'UNAUTHORIZED',
          message: 'API key required. Use X-API-Key header.',
          requestId,
        });
      }

      // Validate API key
      let keyData;
      try {
        keyData = await validateApiKey(apiKey);
      } catch (error) {
        // Audit log: api_key_used failure - invalid key
        await auditLogService.createAuditLogWithContext({
          eventType: 'api_key_used',
          eventCategory: auditLogService.EVENT_CATEGORIES.SECURITY,
          action: auditLogService.AUDIT_ACTIONS.PERMISSION_DENIED,
          resourceType: auditLogService.RESOURCE_TYPES.API_KEY,
          userId: null,
          newValue: {
            reason: 'Invalid API key',
            keyPrefix: apiKey.substring(0, 12),
            error: error.message,
            ipAddress: getClientIp(req),
          },
          request: req,
        });

        return res.status(401).json({
          success: false,
          error: 'UNAUTHORIZED',
          message: 'Invalid API key',
          requestId,
        });
      }

      // Check if key is revoked
      if (keyData.revokedAt) {
        // Audit log: api_key_used failure - revoked key
        await auditLogService.createAuditLogWithContext({
          eventType: 'api_key_used',
          eventCategory: auditLogService.EVENT_CATEGORIES.SECURITY,
          action: auditLogService.AUDIT_ACTIONS.PERMISSION_DENIED,
          resourceType: auditLogService.RESOURCE_TYPES.API_KEY,
          userId: keyData.userId,
          newValue: {
            reason: 'API key revoked',
            keyId: keyData.id,
            keyPrefix: apiKey.substring(0, 12),
            revokedAt: keyData.revokedAt,
            ipAddress: getClientIp(req),
          },
          request: req,
        });

        return res.status(401).json({
          success: false,
          error: 'UNAUTHORIZED',
          message: 'API key has been revoked',
          requestId,
        });
      }

      // Check if key is expired
      if (keyData.expiresAt && new Date(keyData.expiresAt) < new Date()) {
        // Audit log: api_key_used failure - expired key
        await auditLogService.createAuditLogWithContext({
          eventType: 'api_key_used',
          eventCategory: auditLogService.EVENT_CATEGORIES.SECURITY,
          action: auditLogService.AUDIT_ACTIONS.PERMISSION_DENIED,
          resourceType: auditLogService.RESOURCE_TYPES.API_KEY,
          userId: keyData.userId,
          newValue: {
            reason: 'API key expired',
            keyId: keyData.id,
            keyPrefix: apiKey.substring(0, 12),
            expiresAt: keyData.expiresAt,
            ipAddress: getClientIp(req),
          },
          request: req,
        });

        return res.status(401).json({
          success: false,
          error: 'UNAUTHORIZED',
          message: 'API key has expired',
          requestId,
        });
      }

      // Extract user context from API key
      req.user = {
        id: keyData.userId,
        email: keyData.email,
        organizationId: keyData.orgId,
        keyId: keyData.id,
        scopes: keyData.scopes || ['read', 'write'],
        authMethod: 'api_key',
      };

      // Audit log: api_key_used success
      await auditLogService.createAuditLogWithContext({
        eventType: 'api_key_used',
        eventCategory: auditLogService.EVENT_CATEGORIES.SECURITY,
        action: auditLogService.AUDIT_ACTIONS.API_KEY_USED,
        resourceType: auditLogService.RESOURCE_TYPES.API_KEY,
        resourceId: keyData.id,
        userId: keyData.userId,
        newValue: {
          keyId: keyData.id,
          keyPrefix: apiKey.substring(0, 12),
          scopes: req.user.scopes,
          latencyMs: Date.now() - startTime,
          ipAddress: getClientIp(req),
        },
        request: req,
      });

      // Update last used timestamp (async, don't block)
      if (keyData.id) {
        Promise.resolve().then(async () => {
          try {
            await validateApiKey.updateLastUsed?.(keyData.id);
          } catch (error) {
            logger.warn('Failed to update API key last used', { keyId: keyData.id, error });
          }
        });
      }

      // Add request ID to headers for tracing
      res.setHeader('X-Request-ID', requestId);

      next();

    } catch (error) {
      logger.error('API key auth middleware error', { requestId, error });

      // Audit log: api_key_used error
      await auditLogService.createAuditLogWithContext({
        eventType: 'api_key_used',
        eventCategory: auditLogService.EVENT_CATEGORIES.SECURITY,
        action: auditLogService.AUDIT_ACTIONS.PERMISSION_DENIED,
        resourceType: auditLogService.RESOURCE_TYPES.API_KEY,
        userId: null,
        newValue: {
          reason: 'Authentication middleware error',
          error: error.message,
          ipAddress: getClientIp(req),
        },
        request: req,
      });

      return res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'API key authentication failed',
        requestId,
      });
    }
  };
}

/**
 * Optional Authentication Middleware
 * Tries JWT first, then API key, allows unauthenticated requests
 * 
 * @param {Object} options - Middleware options
 * @param {Function} options.validateToken - JWT validation function
 * @param {Function} options.validateApiKey - API key validation function
 * @returns {Function} Express middleware
 */
export function optionalAuthMiddleware(options = {}) {
  const { validateToken, validateApiKey } = options;

  return async (req, res, next) => {
    const requestId = req.headers['x-request-id'] || uuidv4();

    try {
      // Try JWT first
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        try {
          const decoded = await validateToken(token);
          req.user = {
            id: decoded.sub,
            email: decoded.email,
            organizationId: decoded.organizationId || decoded.org_id,
            roles: decoded.roles || [],
            scopes: decoded.scopes || ['read', 'write'],
          };
          return next();
        } catch (error) {
          // JWT failed, continue to API key
        }
      }

      // Try API key
      const apiKey = req.headers['x-api-key'];
      if (apiKey) {
        try {
          const keyData = await validateApiKey(apiKey);
          if (!keyData.revokedAt && (!keyData.expiresAt || new Date(keyData.expiresAt) > new Date())) {
            req.user = {
              id: keyData.userId,
              email: keyData.email,
              organizationId: keyData.orgId,
              keyId: keyData.id,
              scopes: keyData.scopes || ['read', 'write'],
              authMethod: 'api_key',
            };
            return next();
          }
        } catch (error) {
          // API key failed, continue unauthenticated
        }
      }

      // No valid auth, continue unauthenticated
      req.user = null;
      next();

    } catch (error) {
      logger.error('Optional auth middleware error', { requestId, error });
      req.user = null;
      next();
    }
  };
}

/**
 * Logout Middleware
 * Logs logout events for audit trail
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
export async function logoutMiddleware(req, res, next) {
  const requestId = req.headers['x-request-id'] || uuidv4();

  try {
    if (req.user && req.user.id) {
      // Audit log: logout
      await auditLogService.logAuthEvent({
        eventType: 'logout',
        userId: req.user.id,
        request: req,
        details: {
          email: req.user.email,
          authMethod: req.user.authMethod || 'jwt',
          ipAddress: getClientIp(req),
        },
      });
    }

    next();
  } catch (error) {
    logger.error('Logout middleware error', { requestId, error });
    next();
  }
}

/**
 * Rate Limit Exceeded Handler with Audit Logging
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Object} options - Options
 */
export async function rateLimitExceededHandler(req, res, options = {}) {
  const requestId = req.headers['x-request-id'] || uuidv4();

  try {
    // Audit log: rate limit exceeded
    await auditLogService.createAuditLogWithContext({
      eventType: 'rate_limit_exceeded',
      eventCategory: auditLogService.EVENT_CATEGORIES.SECURITY,
      action: auditLogService.AUDIT_ACTIONS.PERMISSION_DENIED,
      resourceType: 'rate_limit',
      userId: req.user?.id,
      newValue: {
        limit: options.limit,
        windowMs: options.windowMs,
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
      },
      request: req,
    });
  } catch (error) {
    logger.error('Rate limit audit logging failed', { requestId, error });
  }

  res.status(429).json({
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests. Please try again later.',
    requestId,
  });
}

export default {
  jwtAuthMiddleware,
  apiKeyAuthMiddleware,
  optionalAuthMiddleware,
  logoutMiddleware,
  rateLimitExceededHandler,
  AUTH_CONFIG,
};

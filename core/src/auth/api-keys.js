/**
 * API Key Authentication Middleware
 * HIVE-MIND Cross-Platform Context Sync
 * 
 * Middleware for authenticating requests using API keys
 * Supports X-API-Key header for server-to-server authentication
 * 
 * Features:
 * - API key validation with expiry and revocation checks
 * - Automatic last_used_at and usage_count tracking
 * - Scope-based authorization
 * - Rate limiting per API key
 * - Multi-tenant isolation
 * 
 * @module auth/api-keys
 */

import { validateApiKey, hasScope, hasAnyScope } from '../services/api-key.service.js';

// ==========================================
// CONSTANTS
// ==========================================

const API_KEY_HEADER = 'x-api-key';
const API_KEY_QUERY_PARAM = 'api_key';

// ==========================================
// RATE LIMITING
// ==========================================

/**
 * Simple in-memory rate limiter for API keys
 * In production, replace with Redis-based rate limiting
 */
const rateLimitStore = new Map();

/**
 * Check if an API key has exceeded its rate limit
 * 
 * @param {string} keyId - API key ID
 * @param {number} limitPerMinute - Maximum requests per minute
 * @returns {boolean} True if rate limit exceeded
 */
function checkRateLimit(keyId, limitPerMinute) {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const key = `ratelimit:${keyId}`;

  const record = rateLimitStore.get(key);

  if (!record) {
    // First request in this window
    rateLimitStore.set(key, {
      count: 1,
      windowStart: now
    });
    return false;
  }

  // Check if we're in a new window
  if (now - record.windowStart > windowMs) {
    rateLimitStore.set(key, {
      count: 1,
      windowStart: now
    });
    return false;
  }

  // Same window - check count
  if (record.count >= limitPerMinute) {
    return true; // Rate limit exceeded
  }

  // Increment count
  record.count++;
  rateLimitStore.set(key, record);
  return false;
}

/**
 * Clean up old rate limit entries (run periodically)
 */
function cleanupRateLimits() {
  const now = Date.now();
  const windowMs = 60 * 1000;

  for (const [key, record] of rateLimitStore.entries()) {
    if (now - record.windowStart > windowMs * 2) {
      rateLimitStore.delete(key);
    }
  }
}

// Clean up every 5 minutes
setInterval(cleanupRateLimits, 5 * 60 * 1000);

// ==========================================
// MIDDLEWARE FUNCTIONS
// ==========================================

/**
 * Extract API key from request
 * 
 * Priority:
 * 1. X-API-Key header
 * 2. api_key query parameter (for webhooks)
 * 
 * @param {Object} req - Express request object
 * @returns {string|null} API key or null
 */
function extractApiKey(req) {
  // Check header first
  const headerKey = req.headers[API_KEY_HEADER];
  if (headerKey && typeof headerKey === 'string') {
    return headerKey.trim();
  }

  // Check query parameter
  const queryKey = req.query[API_KEY_QUERY_PARAM];
  if (queryKey && typeof queryKey === 'string') {
    return queryKey.trim();
  }

  return null;
}

/**
 * API Key Authentication Middleware
 * 
 * Authenticates requests using API keys from the X-API-Key header.
 * Sets req.user with the authenticated user context.
 * 
 * Usage:
 * ```javascript
 * app.use('/api/protected', apiKeyAuth);
 * ```
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next middleware
 * 
 * @response {401} Missing API key
 * @response {401} Invalid API key
 * @response {401} Expired API key
 * @response {401} Revoked API key
 * @response {429} Rate limit exceeded
 */
export function apiKeyAuth(req, res, next) {
  const apiKey = extractApiKey(req);

  if (!apiKey) {
    // No API key provided - let JWT auth handle it
    req.authMethod = null;
    return next();
  }

  // Validate the API key
  validateApiKey(apiKey)
    .then(validated => {
      if (!validated) {
        return res.status(401).json({
          success: false,
          error: 'UNAUTHORIZED',
          message: 'Invalid or expired API key',
          requestId: req.requestId || null
        });
      }

      // Check rate limit
      if (checkRateLimit(validated.id, validated.rateLimitPerMinute)) {
        return res.status(429).json({
          success: false,
          error: 'RATE_LIMIT_EXCEEDED',
          message: `Rate limit of ${validated.rateLimitPerMinute} requests per minute exceeded`,
          retryAfter: 60,
          requestId: req.requestId || null
        });
      }

      // Set authenticated user context
      req.user = {
        id: validated.userId,
        email: validated.user.email,
        displayName: validated.user.displayName,
        organizationId: validated.orgId,
        organization: validated.organization,
        scopes: validated.scopes,
        authMethod: 'api_key',
        apiKeyId: validated.id
      };

      req.authMethod = 'api_key';

      // Log authentication (for audit trail)
      if (process.env.LOG_LEVEL === 'debug') {
        console.debug('[API_KEY_AUTH] Authenticated', {
          userId: validated.userId,
          keyId: validated.id,
          path: req.path,
          method: req.method
        });
      }

      next();
    })
    .catch(error => {
      console.error('[API_KEY_AUTH] Validation error:', error);
      return res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Authentication service unavailable',
        requestId: req.requestId || null
      });
    });
}

/**
 * Require API Key Authentication Middleware
 * 
 * Forces API key authentication (no JWT fallback)
 * Returns 401 if no valid API key is provided
 * 
 * Usage:
 * ```javascript
 * app.post('/api/webhooks', requireApiKeyAuth);
 * ```
 */
export function requireApiKeyAuth(req, res, next) {
  const apiKey = extractApiKey(req);

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'API key required. Provide X-API-Key header.',
      requestId: req.requestId || null
    });
  }

  // Use the standard apiKeyAuth middleware logic
  apiKeyAuth(req, res, next);
}

/**
 * Require Specific Scope Middleware
 * 
 * Checks if the authenticated user (via API key or JWT) has the required scope
 * Must be used after apiKeyAuth or jwtAuth middleware
 * 
 * Usage:
 * ```javascript
 * app.post('/api/memories', apiKeyAuth, requireScope('memories:write'));
 * ```
 * 
 * @param {string|string[]} requiredScopes - Required scope(s)
 * @returns {Function} Express middleware
 */
export function requireScope(requiredScopes) {
  const scopes = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];

  return (req, res, next) => {
    if (!req.user || !req.user.scopes) {
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId: req.requestId || null
      });
    }

    // Check if user has any of the required scopes
    if (!hasAnyScope(req.user, scopes)) {
      return res.status(403).json({
        success: false,
        error: 'INSUFFICIENT_SCOPE',
        message: `Required scope: ${scopes.join(' or ')}`,
        required: scopes,
        provided: req.user.scopes,
        requestId: req.requestId || null
      });
    }

    next();
  };
}

/**
 * Optional API Key Authentication
 * 
 * Attempts API key authentication but doesn't require it.
 * Sets req.user if valid API key is provided, otherwise continues without auth.
 * 
 * Usage:
 * ```javascript
 * app.get('/api/public-data', optionalApiKeyAuth, handler);
 * ```
 */
export function optionalApiKeyAuth(req, res, next) {
  const apiKey = extractApiKey(req);

  if (!apiKey) {
    req.authMethod = null;
    return next();
  }

  // Try to validate, but don't fail if invalid
  validateApiKey(apiKey)
    .then(validated => {
      if (validated) {
        // Set authenticated user context
        req.user = {
          id: validated.userId,
          email: validated.user.email,
          displayName: validated.user.displayName,
          organizationId: validated.orgId,
          organization: validated.organization,
          scopes: validated.scopes,
          authMethod: 'api_key',
          apiKeyId: validated.id
        };
        req.authMethod = 'api_key';
      } else {
        req.authMethod = null;
      }
      next();
    })
    .catch(() => {
      // Silently fail - auth is optional
      req.authMethod = null;
      next();
    });
}

/**
 * Multi-Auth Middleware
 * 
 * Supports both JWT and API key authentication
 * Tries API key first, then falls back to JWT
 * 
 * Usage:
 * ```javascript
 * app.use('/api', multiAuth);
 * ```
 */
export function multiAuth(req, res, next) {
  const apiKey = extractApiKey(req);

  // If API key is present, use API key auth
  if (apiKey) {
    return apiKeyAuth(req, res, next);
  }

  // Otherwise, let JWT auth handle it
  req.authMethod = null;
  next();
}

/**
 * Deny API Key Access Middleware
 * 
 * Blocks requests authenticated via API key
 * Use for sensitive endpoints that require JWT only
 * 
 * Usage:
 * ```javascript
 * app.post('/api/auth/delete-account', denyApiKeyAuth, handler);
 * ```
 */
export function denyApiKeyAuth(req, res, next) {
  if (req.authMethod === 'api_key') {
    return res.status(403).json({
      success: false,
      error: 'FORBIDDEN',
      message: 'API key authentication not allowed for this endpoint. Use JWT.',
      requestId: req.requestId || null
    });
  }

  next();
}

// ==========================================
// EXPORTS
// ==========================================

export default {
  apiKeyAuth,
  requireApiKeyAuth,
  requireScope,
  optionalApiKeyAuth,
  multiAuth,
  denyApiKeyAuth,
  extractApiKey,
  checkRateLimit
};

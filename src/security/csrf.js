/**
 * =============================================================================
 * HIVE-MIND CSRF Protection Middleware
 * =============================================================================
 * Purpose: Prevent Cross-Site Request Forgery attacks
 * Compliance: OWASP CSRF Prevention Cheat Sheet
 * Implementation: Double Submit Cookie Pattern + SameSite Cookies
 * =============================================================================
 */

const crypto = require('crypto');

// Configuration
const CSRF_CONFIG = {
  cookieName: 'hivemind_csrf',
  headerName: 'X-CSRF-Token',
  cookieOptions: {
    httpOnly: false, // Must be readable by JavaScript
    secure: true,    // Only send over HTTPS
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    path: '/',
  },
  skipMethods: ['GET', 'HEAD', 'OPTIONS'], // Safe methods don't need CSRF protection
};

/**
 * Generate a cryptographically secure CSRF token
 * @returns {string} CSRF token
 */
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * CSRF Protection Middleware
 * Implements Double Submit Cookie pattern
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
function csrfProtection(req, res, next) {
  // Skip CSRF check for safe methods
  if (CSRF_CONFIG.skipMethods.includes(req.method)) {
    // Still generate token for forms
    const token = generateCsrfToken();
    res.cookie(CSRF_CONFIG.cookieName, token, CSRF_CONFIG.cookieOptions);
    res.locals.csrfToken = token;
    return next();
  }

  // Skip CSRF for API routes using JWT authentication
  // JWT provides its own protection against CSRF
  if (req.path.startsWith('/api/')) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return next();
    }
  }

  // Get token from header
  const headerToken = req.headers[CSRF_CONFIG.headerName.toLowerCase()];
  
  // Get token from cookie
  const cookieToken = req.cookies?.[CSRF_CONFIG.cookieName];

  // Validate tokens
  if (!headerToken || !cookieToken) {
    return res.status(403).json({
      error: 'CSRF token missing',
      message: 'A valid CSRF token is required for this request',
      code: 'CSRF_TOKEN_MISSING',
    });
  }

  // Compare tokens (constant-time comparison)
  if (!safeCompare(headerToken, cookieToken)) {
    return res.status(403).json({
      error: 'CSRF token invalid',
      message: 'The CSRF token provided does not match',
      code: 'CSRF_TOKEN_INVALID',
    });
  }

  // Token is valid, proceed
  next();
}

/**
 * Constant-time string comparison to prevent timing attacks
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} Whether strings are equal
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

/**
 * CSRF token middleware for forms
 * Adds CSRF token to response locals for template rendering
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
function csrfToken(req, res, next) {
  const token = generateCsrfToken();
  
  res.cookie(CSRF_CONFIG.cookieName, token, CSRF_CONFIG.cookieOptions);
  res.locals.csrfToken = token;
  
  next();
}

/**
 * Validate CSRF token manually
 * Useful for custom validation scenarios
 * 
 * @param {string} token - Token to validate
 * @param {Object} req - Express request
 * @returns {boolean} Whether token is valid
 */
function validateCsrfToken(token, req) {
  const cookieToken = req.cookies?.[CSRF_CONFIG.cookieName];
  
  if (!token || !cookieToken) {
    return false;
  }
  
  return safeCompare(token, cookieToken);
}

/**
 * CSRF protection for WebSocket connections
 * Validates token during WebSocket handshake
 * 
 * @param {Object} ws - WebSocket
 * @param {Object} req - HTTP request
 * @param {Function} next - Next handler
 */
function csrfProtectionWebSocket(ws, req, next) {
  const token = req.headers['sec-websocket-protocol'];
  const cookieToken = req.cookies?.[CSRF_CONFIG.cookieName];
  
  if (!token || !cookieToken || !safeCompare(token, cookieToken)) {
    ws.close(4003, 'CSRF validation failed');
    return;
  }
  
  next();
}

/**
 * Refresh CSRF token
 * Generates a new token and updates the cookie
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @returns {string} New CSRF token
 */
function refreshCsrfToken(req, res) {
  const token = generateCsrfToken();
  res.cookie(CSRF_CONFIG.cookieName, token, CSRF_CONFIG.cookieOptions);
  res.locals.csrfToken = token;
  return token;
}

/**
 * CSRF middleware configuration options
 * @typedef {Object} CsrfOptions
 * @property {string} [cookieName] - Cookie name
 * @property {string} [headerName] - Header name
 * @property {boolean} [skipApiRoutes] - Skip CSRF for /api/ routes
 * @property {string[]} [skipPaths] - Additional paths to skip
 */

/**
 * Create configurable CSRF middleware
 * @param {CsrfOptions} options - Configuration options
 * @returns {Function} CSRF middleware
 */
function createCsrfMiddleware(options = {}) {
  const config = {
    cookieName: options.cookieName || CSRF_CONFIG.cookieName,
    headerName: options.headerName || CSRF_CONFIG.headerName,
    skipApiRoutes: options.skipApiRoutes !== false,
    skipPaths: options.skipPaths || [],
  };

  return (req, res, next) => {
    // Skip configured paths
    if (config.skipPaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    // Skip API routes if configured
    if (config.skipApiRoutes && req.path.startsWith('/api/')) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        return next();
      }
    }

    // Use default CSRF_CONFIG values for cookie options
    const cookieOptions = {
      ...CSRF_CONFIG.cookieOptions,
      name: config.cookieName,
    };

    // Safe methods - just set cookie
    if (CSRF_CONFIG.skipMethods.includes(req.method)) {
      const token = generateCsrfToken();
      res.cookie(config.cookieName, token, cookieOptions);
      res.locals.csrfToken = token;
      return next();
    }

    // Validate token
    const headerToken = req.headers[config.headerName.toLowerCase()];
    const cookieToken = req.cookies?.[config.cookieName];

    if (!headerToken || !cookieToken || !safeCompare(headerToken, cookieToken)) {
      return res.status(403).json({
        error: 'CSRF validation failed',
        code: 'CSRF_VALIDATION_FAILED',
      });
    }

    next();
  };
}

/**
 * CSRF error handler middleware
 * Logs CSRF failures for security monitoring
 * 
 * @param {Object} err - Error object
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
async function csrfErrorHandler(err, req, res, next) {
  if (err.code === 'CSRF_VALIDATION_FAILED' || err.code === 'CSRF_TOKEN_INVALID') {
    const { logger } = require('../core/utils/logger');
    const { auditLog } = require('../audit/logger');

    logger.warn('CSRF validation failed', {
      path: req.path,
      method: req.method,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Log for security monitoring
    await auditLog({
      eventType: 'csrf_violation',
      eventCategory: 'security',
      resourceType: 'system',
      action: 'read',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      processingBasis: 'GDPR Article 6(1)(f) - Legitimate interest (security)',
      legalBasisNote: 'CSRF validation failed',
    }).catch(() => {});
  }

  next(err);
}

module.exports = {
  csrfProtection,
  csrfToken,
  validateCsrfToken,
  csrfProtectionWebSocket,
  refreshCsrfToken,
  createCsrfMiddleware,
  csrfErrorHandler,
  generateCsrfToken,
  safeCompare,
  CSRF_CONFIG,
};

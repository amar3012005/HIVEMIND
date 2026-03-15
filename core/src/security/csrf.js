/**
 * CSRF Protection Middleware
 * Generates and validates CSRF tokens
 *
 * Features:
 * - Token generation with crypto.randomBytes
 * - Token validation
 * - Token rotation
 * - Cookie-based token storage
 */

import crypto from 'crypto';

// CSRF configuration
const CSRF_CONFIG = {
  tokenLength: 32,
  tokenExpiryHours: 2,
  cookieName: 'csrfToken',
  headerName: 'X-CSRF-Token',
};

/**
 * Generate CSRF token
 */
export function generateCsrfToken() {
  return crypto.randomBytes(CSRF_CONFIG.tokenLength).toString('hex');
}

/**
 * Store CSRF token in session
 */
export function storeCsrfToken(req, res) {
  const token = generateCsrfToken();
  req.session.csrfToken = token;
  req.session.csrfTokenExpiry = Date.now() + CSRF_CONFIG.tokenExpiryHours * 60 * 60 * 1000;
  return token;
}

/**
 * Get CSRF token from session
 */
export function getCsrfToken(req) {
  if (!req.session || !req.session.csrfToken) {
    return storeCsrfToken(req);
  }

  // Check if token has expired
  if (req.session.csrfTokenExpiry && Date.now() > req.session.csrfTokenExpiry) {
    return storeCsrfToken(req);
  }

  return req.session.csrfToken;
}

/**
 * CSRF protection middleware
 */
export function csrfProtection(req, res, next) {
  // Skip for API routes using JWT (stateless)
  if (req.path.startsWith('/api/') || req.path.startsWith('/gdpr/')) {
    // Still set CSRF token for any browser-based routes
    if (!req.headers['x-csrf-token'] && !req.headers['x-session-id']) {
      const token = getCsrfToken(req);
      res.setHeader('X-CSRF-Token', token);
    }
    return next();
  }

  // Skip for GET, HEAD, OPTIONS requests
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    // Set CSRF token for browser clients
    const token = getCsrfToken(req);
    res.setHeader('X-CSRF-Token', token);
    return next();
  }

  // Validate CSRF token for state-changing requests
  const providedToken = req.headers[CSRF_CONFIG.headerName.toLowerCase()] ||
                        req.body?.csrfToken ||
                        req.query?.csrfToken;

  const sessionToken = req.session?.csrfToken;

  if (!providedToken || !sessionToken) {
    res.status(403).json({
      error: 'CSRF token missing',
      message: 'CSRF token is required for this request',
    });
    return;
  }

  if (providedToken !== sessionToken) {
    res.status(403).json({
      error: 'CSRF token invalid',
      message: 'CSRF token validation failed',
    });
    return;
  }

  // Token is valid
  next();
}

/**
 * CSRF token middleware (sets token on all responses)
 */
export function csrfTokenMiddleware(req, res, next) {
  // Skip for API routes
  if (req.path.startsWith('/api/') || req.path.startsWith('/gdpr/')) {
    return next();
  }

  // Set CSRF token on all responses
  const token = getCsrfToken(req);
  res.setHeader('X-CSRF-Token', token);

  next();
}

/**
 * Validate CSRF token
 */
export function validateCsrfToken(providedToken, sessionToken) {
  if (!providedToken || !sessionToken) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(providedToken),
    Buffer.from(sessionToken)
  );
}

/**
 * Rotate CSRF token
 */
export function rotateCsrfToken(req) {
  const token = generateCsrfToken();
  req.session.csrfToken = token;
  req.session.csrfTokenExpiry = Date.now() + CSRF_CONFIG.tokenExpiryHours * 60 * 60 * 1000;
  return token;
}

/**
 * CSRF protection with custom configuration
 */
export function csrfMiddleware(options = {}) {
  const {
    tokenLength = CSRF_CONFIG.tokenLength,
    tokenExpiryHours = CSRF_CONFIG.tokenExpiryHours,
    cookieName = CSRF_CONFIG.cookieName,
    headerName = CSRF_CONFIG.headerName,
    skipPaths = ['/health', '/metrics', '/favicon.ico'],
    skipMethods = ['GET', 'HEAD', 'OPTIONS'],
  } = options;

  return (req, res, next) => {
    // Skip if path matches
    if (skipPaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    // Skip if method matches
    if (skipMethods.includes(req.method)) {
      return next();
    }

    // Generate or retrieve token
    let token = req.session?.csrfToken;
    const now = Date.now();

    // Check if token has expired
    if (!token || (req.session?.csrfTokenExpiry && now > req.session.csrfTokenExpiry)) {
      token = generateCsrfToken();
      req.session.csrfToken = token;
      req.session.csrfTokenExpiry = now + tokenExpiryHours * 60 * 60 * 1000;
    }

    // Set token on response
    res.setHeader(headerName, token);

    // Validate token for state-changing requests
    const providedToken = req.headers[headerName.toLowerCase()] ||
                          req.body?.csrfToken ||
                          req.query?.csrfToken;

    if (!providedToken) {
      res.status(403).json({
        error: 'CSRF token missing',
        message: 'CSRF token is required for this request',
      });
      return;
    }

    if (!validateCsrfToken(providedToken, token)) {
      // Rotate token on validation failure
      rotateCsrfToken(req);

      res.status(403).json({
        error: 'CSRF token invalid',
        message: 'CSRF token validation failed',
      });
      return;
    }

    next();
  };
}

/**
 * CSRF token generator middleware
 */
export function csrfTokenGenerator(req, res, next) {
  const token = generateCsrfToken();
  res.locals.csrfToken = token;
  res.setHeader(CSRF_CONFIG.headerName, token);
  next();
}

/**
 * Get CSRF token from request
 */
export function getCsrfTokenFromRequest(req) {
  return req.headers[CSRF_CONFIG.headerName.toLowerCase()] ||
         req.body?.csrfToken ||
         req.query?.csrfToken;
}

/**
 * Validate CSRF token from request
 */
export function validateCsrfTokenFromRequest(req, sessionToken) {
  const providedToken = getCsrfTokenFromRequest(req);
  return validateCsrfToken(providedToken, sessionToken);
}

/**
 * CSRF protection for specific routes
 */
export function csrfForRoutes(routes, options = {}) {
  return (req, res, next) => {
    if (routes.some(route => req.path.startsWith(route))) {
      return csrfMiddleware(options)(req, res, next);
    }
    next();
  };
}

/**
 * CSRF protection for specific methods
 */
export function csrfForMethods(methods, options = {}) {
  return (req, res, next) => {
    if (methods.includes(req.method)) {
      return csrfMiddleware(options)(req, res, next);
    }
    next();
  };
}

export default {
  generateCsrfToken,
  storeCsrfToken,
  getCsrfToken,
  csrfProtection,
  csrfTokenMiddleware,
  validateCsrfToken,
  rotateCsrfToken,
  csrfMiddleware,
  csrfTokenGenerator,
  getCsrfTokenFromRequest,
  validateCsrfTokenFromRequest,
  csrfForRoutes,
  csrfForMethods,
  CSRF_CONFIG,
};

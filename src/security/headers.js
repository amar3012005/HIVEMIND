/**
 * =============================================================================
 * HIVE-MIND Security Headers Middleware
 * =============================================================================
 * Purpose: Implement OWASP secure headers recommendations
 * Compliance: GDPR Article 32, NIS2, DORA
 * Reference: OWASP Secure Headers Project
 * =============================================================================
 */

const crypto = require('crypto');

// Configuration
const SECURITY_CONFIG = {
  hstsMaxAge: 31536000, // 1 year in seconds
  hstsIncludeSubDomains: true,
  hstsPreload: true,
  cspReportOnly: false, // Set to true for testing before enforcement
  cspReportUri: '/api/security/csp-report',
};

/**
 * Security headers middleware
 * Applies all security headers to responses
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
function securityHeaders(req, res, next) {
  // ===========================================================================
  // HTTP Strict Transport Security (HSTS)
  // Prevents protocol downgrade attacks and cookie hijacking
  // ===========================================================================
  let hstsValue = `max-age=${SECURITY_CONFIG.hstsMaxAge}`;
  
  if (SECURITY_CONFIG.hstsIncludeSubDomains) {
    hstsValue += '; includeSubDomains';
  }
  
  if (SECURITY_CONFIG.hstsPreload) {
    hstsValue += '; preload';
  }
  
  res.setHeader('Strict-Transport-Security', hstsValue);

  // ===========================================================================
  // Content Security Policy (CSP)
  // Prevents XSS, data injection, and code injection attacks
  // ===========================================================================
  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self'",
    "script-src-elem 'self'",
    "style-src 'self' 'unsafe-inline'", // Required for some CSS frameworks
    "style-src-elem 'self' 'unsafe-inline'",
    "img-src 'self' data: https: blob:",
    "font-src 'self'",
    "connect-src 'self' https://api.hivemind.io wss://api.hivemind.io",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
    "block-all-mixed-content",
  ];

  if (SECURITY_CONFIG.cspReportUri) {
    cspDirectives.push(`report-uri ${SECURITY_CONFIG.cspReportUri}`);
    cspDirectives.push('report-to csp-endpoint');
  }

  const cspHeader = SECURITY_CONFIG.cspReportOnly 
    ? 'Content-Security-Policy-Report-Only' 
    : 'Content-Security-Policy';
  
  res.setHeader(cspHeader, cspDirectives.join('; '));

  // ===========================================================================
  // X-Content-Type-Options
  // Prevents MIME type sniffing
  // ===========================================================================
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // ===========================================================================
  // X-Frame-Options
  // Prevents clickjacking attacks
  // ===========================================================================
  res.setHeader('X-Frame-Options', 'DENY');

  // ===========================================================================
  // X-XSS-Protection
  // Legacy XSS filter (for older browsers)
  // ===========================================================================
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // ===========================================================================
  // Referrer-Policy
  // Controls referrer information sent with requests
  // ===========================================================================
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // ===========================================================================
  // Permissions-Policy (formerly Feature-Policy)
  // Controls which browser features can be used
  // ===========================================================================
  const permissionsPolicy = [
    'camera=()',
    'microphone=()',
    'geolocation=()',
    'payment=()',
    'usb=()',
    'accelerometer=()',
    'gyroscope=()',
    'magnetometer=()',
    'ambient-light-sensor=()',
    'autoplay=()',
    'fullscreen=(self)',
    'screen-wake-lock=()',
  ].join(', ');
  
  res.setHeader('Permissions-Policy', permissionsPolicy);

  // ===========================================================================
  // Cross-Origin Headers
  // Prevents cross-origin attacks and information leakage
  // ===========================================================================
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  // ===========================================================================
  // Cache-Control for API Routes
  // Prevents caching of sensitive data
  // ===========================================================================
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  // ===========================================================================
  // Additional Security Headers
  // ===========================================================================
  
  // Prevent DNS prefetching (privacy)
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  
  // Download prompt for certain content types
  res.setHeader('X-Download-Options', 'noopen');
  
  // Prevent IE from executing downloads
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

  next();
}

/**
 * Generate CSP nonce for inline scripts
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @returns {string} CSP nonce
 */
function generateCspNonce(req, res) {
  const nonce = crypto.randomBytes(16).toString('base64');
  
  // Store nonce for use in templates
  res.locals.cspNonce = nonce;
  
  return nonce;
}

/**
 * CSP Report endpoint handler
 * Logs CSP violations for analysis
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
function handleCspReport(req, res) {
  const { logger } = require('../core/utils/logger');
  const { auditLog } = require('../audit/logger');

  const report = req.body;
  
  logger.warn('CSP Violation Reported', {
    report: report['csp-report'],
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  // Log CSP violation for security monitoring
  auditLog({
    eventType: 'csp_violation',
    eventCategory: 'security',
    resourceType: 'system',
    action: 'read',
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    newValue: report['csp-report'],
    processingBasis: 'GDPR Article 6(1)(f) - Legitimate interest (security)',
    legalBasisNote: 'CSP violation detected',
  }).catch(() => {
    // Don't fail on audit logging errors
  });

  // Always return 204 (no content)
  res.sendStatus(204);
}

/**
 * Security headers for static assets
 * Less restrictive for public assets
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
function staticAssetHeaders(req, res, next) {
  // Allow caching for static assets
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  
  // Still apply security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  
  next();
}

/**
 * Security headers for HTML responses
 * Most restrictive for HTML content
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
function htmlResponseHeaders(req, res, next) {
  // No caching for HTML
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  next();
}

/**
 * Verify security headers are present
 * Testing utility for security audits
 * 
 * @param {Object} headers - Response headers
 * @returns {Object} Verification results
 */
function verifySecurityHeaders(headers) {
  const required = [
    'strict-transport-security',
    'content-security-policy',
    'x-content-type-options',
    'x-frame-options',
    'x-xss-protection',
    'referrer-policy',
    'permissions-policy',
    'cross-origin-opener-policy',
    'cross-origin-embedder-policy',
  ];

  const results = {
    passed: [],
    failed: [],
    warnings: [],
  };

  for (const header of required) {
    if (headers[header]) {
      results.passed.push(header);
    } else {
      results.failed.push(header);
    }
  }

  // Check for weak configurations
  if (headers['strict-transport-security']?.includes('max-age=0')) {
    results.warnings.push('HSTS max-age is 0 (disabled)');
  }

  if (headers['content-security-policy']?.includes("'unsafe-inline'")) {
    results.warnings.push("CSP allows 'unsafe-inline' scripts");
  }

  if (headers['content-security-policy']?.includes("'unsafe-eval'")) {
    results.warnings.push("CSP allows 'unsafe-eval' scripts");
  }

  return {
    allPassed: results.failed.length === 0,
    ...results,
  };
}

module.exports = {
  securityHeaders,
  staticAssetHeaders,
  htmlResponseHeaders,
  generateCspNonce,
  handleCspReport,
  verifySecurityHeaders,
  SECURITY_CONFIG,
};

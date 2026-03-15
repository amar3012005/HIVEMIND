/**
 * Security Headers Middleware
 * Implements OWASP secure headers recommendations
 *
 * Features:
 * - Strict Transport Security (HSTS)
 * - Content Security Policy (CSP)
 * - X-Content-Type-Options
 * - X-Frame-Options
 * - X-XSS-Protection
 * - Referrer-Policy
 * - Permissions-Policy
 * - Cross-Origin policies
 * - Cache-Control for sensitive data
 */

/**
 * Security headers middleware
 * Implements OWASP secure headers recommendations
 */
export function securityHeaders(req, res, next) {
  // Strict Transport Security
  // max-age=31536000 (1 year), includeSubDomains, preload
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload'
  );

  // Content Security Policy
  // Restrictive but allows necessary functionality
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      "connect-src 'self' https://api.hivemind.io",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "upgrade-insecure-requests",
    ].join('; ')
  );

  // X-Content-Type-Options
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // X-Frame-Options
  res.setHeader('X-Frame-Options', 'DENY');

  // X-XSS-Protection (legacy but still useful)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer-Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions-Policy (formerly Feature-Policy)
  res.setHeader(
    'Permissions-Policy',
    [
      'camera=()',
      'microphone=()',
      'geolocation=()',
      'payment=()',
      'usb=()',
      'accelerometer=()',
      'gyroscope=()',
      'magnetometer=()',
      'autoplay=()',
      'camera=()',
      'display-capture=()',
      'document-domain=()',
      'encrypted-media=()',
      'fullscreen=()',
      'gamepad=()',
      'geolocation=()',
      'gyroscope=()',
      'keyboard-map=()',
      'microphone=()',
      'midi=()',
      'payment=()',
      'picture-in-picture=()',
      'screen-wake-lock=()',
      'sync-xhr=()',
      'usb=()',
      'web-share=()',
      'xr-spatial-tracking=()',
    ].join(', ')
  );

  // Cross-Origin-Opener-Policy
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  // Cross-Origin-Embedder-Policy
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

  // Cross-Origin-Resource-Policy
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  // Cross-Origin-Resource-Policy
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  // Cache-Control for sensitive data (API routes)
  if (req.path.startsWith('/api/') || req.path.startsWith('/gdpr/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  next();
}

/**
 * Security headers configuration
 */
export const SECURITY_HEADERS_CONFIG = {
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  csp: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    fontSrc: ["'self'"],
    connectSrc: ["'self'", 'https://api.hivemind.io'],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    upgradeInsecureRequests: true,
  },
  permissionsPolicy: {
    camera: [],
    microphone: [],
    geolocation: [],
    payment: [],
    usb: [],
    accelerometer: [],
    gyroscope: [],
  },
};

/**
 * Generate CSP nonce for inline scripts
 */
export function generateCspNonce() {
  return crypto.randomUUID();
}

/**
 * Set CSP nonce header
 */
export function setCspNonce(req, res, next) {
  res.locals.cspNonce = crypto.randomUUID();
  res.setHeader('Content-Security-Policy-Nonce', res.locals.cspNonce);
  next();
}

/**
 * Custom CSP middleware for dynamic policies
 */
export function customCspMiddleware(options = {}) {
  const {
    additionalScriptSrc = [],
    additionalConnectSrc = [],
  } = options;

  return (req, res, next) => {
    const cspDirectives = [
      "default-src 'self'",
      `script-src 'self' ${additionalScriptSrc.join(' ')}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      `connect-src 'self' https://api.hivemind.io ${additionalConnectSrc.join(' ')}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "upgrade-insecure-requests",
    ];

    res.setHeader('Content-Security-Policy', cspDirectives.join('; '));
    next();
  };
}

/**
 * Remove sensitive headers
 */
export function removeSensitiveHeaders(req, res, next) {
  // Remove X-Powered-By header
  res.removeHeader('X-Powered-By');

  // Remove Server header (optional)
  // res.removeHeader('Server');

  next();
}

/**
 * Security headers combined middleware
 */
export function securityHeadersMiddleware(req, res, next) {
  securityHeaders(req, res, next);
}

export default {
  securityHeaders,
  SECURITY_HEADERS_CONFIG,
  generateCspNonce,
  setCspNonce,
  customCspMiddleware,
  removeSensitiveHeaders,
  securityHeadersMiddleware,
};

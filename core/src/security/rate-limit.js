/**
 * Rate Limiting Middleware
 * User-based rate limiting with configurable limits
 *
 * Features:
 * - Per-user rate limiting
 * - Configurable limits (default: 100 req/min)
 * - Redis-backed storage for distributed systems
 * - Exponential backoff for repeated violations
 * - Rate limit headers in responses
 */

import crypto from 'crypto';

// Rate limit configuration
const RATE_LIMIT_CONFIG = {
  defaultLimit: 100, // requests per window
  defaultWindowMs: 60 * 1000, // 1 minute
  windowMs: 60 * 1000, // 1 minute
  maxRetries: 3,
  backoffMultiplier: 2,
  storage: 'memory', // 'memory' or 'redis'
};

// In-memory storage for rate limiting
const rateLimitStore = new Map();

/**
 * Get client identifier
 */
function getClientId(req) {
  // Use user ID if authenticated
  if (req.user?.id) {
    return `user:${req.user.id}`;
  }

  // Fall back to IP address
  return `ip:${req.ip || req.connection.remoteAddress}`;
}

/**
 * Check rate limit
 */
export function checkRateLimit(clientId, options = {}) {
  const {
    limit = RATE_LIMIT_CONFIG.defaultLimit,
    windowMs = RATE_LIMIT_CONFIG.windowMs,
  } = options;

  const now = Date.now();
  const windowStart = now - windowMs;

  // Get or create client record
  let clientRecord = rateLimitStore.get(clientId);

  if (!clientRecord) {
    clientRecord = {
      requests: [],
      blockedUntil: null,
      retryAfter: 0,
    };
  }

  // Clean old requests
  clientRecord.requests = clientRecord.requests.filter(
    timestamp => timestamp > windowStart
  );

  // Check if client is blocked
  if (clientRecord.blockedUntil && now < clientRecord.blockedUntil) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt: clientRecord.blockedUntil,
      retryAfter: Math.ceil((clientRecord.blockedUntil - now) / 1000),
      retryCount: clientRecord.retryCount || 0,
    };
  }

  // Check if limit exceeded
  if (clientRecord.requests.length >= limit) {
    // Calculate backoff
    const retryCount = (clientRecord.retryCount || 0) + 1;
    const backoffMs = Math.min(
      windowMs * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, retryCount - 1),
      3600 * 1000 // Max 1 hour
    );

    const blockedUntil = now + backoffMs;

    clientRecord.blockedUntil = blockedUntil;
    clientRecord.retryCount = retryCount;
    rateLimitStore.set(clientId, clientRecord);

    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt: blockedUntil,
      retryAfter: Math.ceil(backoffMs / 1000),
      retryCount,
      blocked: true,
    };
  }

  // Record request
  clientRecord.requests.push(now);
  clientRecord.retryCount = 0;
  rateLimitStore.set(clientId, clientRecord);

  // Calculate remaining requests
  const remaining = Math.max(0, limit - clientRecord.requests.length);

  // Calculate reset time (end of current window)
  const resetAt = now + windowMs;

  return {
    allowed: true,
    limit,
    remaining,
    resetAt,
    retryAfter: 0,
    retryCount: 0,
  };
}

/**
 * Rate limiting middleware
 */
export function rateLimitMiddleware(options = {}) {
  const {
    limit = RATE_LIMIT_CONFIG.defaultLimit,
    windowMs = RATE_LIMIT_CONFIG.windowMs,
    skipPaths = ['/health', '/metrics', '/favicon.ico'],
    keyGenerator = getClientId,
  } = options;

  return (req, res, next) => {
    // Skip if path matches
    if (skipPaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    const clientId = keyGenerator(req);

    const result = checkRateLimit(clientId, { limit, windowMs });

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000));

    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfter);
      res.setHeader('X-RateLimit-Retry-After', result.retryAfter);

      const status = result.blocked ? 429 : 429;

      res.status(status).json({
        error: 'Rate limit exceeded',
        message: `Too many requests. Please try again in ${result.retryAfter} seconds.`,
        retryAfter: result.retryAfter,
        limit: result.limit,
        windowMs,
      });
      return;
    }

    next();
  };
}

/**
 * Rate limit middleware with custom key
 */
export function rateLimitByKey(key, options = {}) {
  return (req, res, next) => {
    const result = checkRateLimit(key, options);

    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000));

    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfter);
      res.status(429).json({
        error: 'Rate limit exceeded',
        message: `Too many requests. Please try again in ${result.retryAfter} seconds.`,
        retryAfter: result.retryAfter,
        limit: result.limit,
      });
      return;
    }

    next();
  };
}

/**
 * Rate limit middleware for specific routes
 */
export function rateLimitForRoutes(routes, options = {}) {
  return (req, res, next) => {
    if (routes.some(route => req.path.startsWith(route))) {
      return rateLimitMiddleware(options)(req, res, next);
    }
    next();
  };
}

/**
 * Get rate limit status for client
 */
export function getRateLimitStatus(clientId, options = {}) {
  const {
    limit = RATE_LIMIT_CONFIG.defaultLimit,
    windowMs = RATE_LIMIT_CONFIG.windowMs,
  } = options;

  const now = Date.now();
  const windowStart = now - windowMs;

  const clientRecord = rateLimitStore.get(clientId);

  if (!clientRecord) {
    return {
      allowed: true,
      limit,
      remaining: limit,
      resetAt: now + windowMs,
      retryAfter: 0,
    };
  }

  // Clean old requests
  clientRecord.requests = clientRecord.requests.filter(
    timestamp => timestamp > windowStart
  );

  // Check if blocked
  if (clientRecord.blockedUntil && now < clientRecord.blockedUntil) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt: clientRecord.blockedUntil,
      retryAfter: Math.ceil((clientRecord.blockedUntil - now) / 1000),
      retryCount: clientRecord.retryCount || 0,
      blocked: true,
    };
  }

  // Calculate remaining
  const remaining = Math.max(0, limit - clientRecord.requests.length);
  const resetAt = now + windowMs;

  return {
    allowed: true,
    limit,
    remaining,
    resetAt,
    retryAfter: 0,
    retryCount: clientRecord.retryCount || 0,
  };
}

/**
 * Reset rate limit for client
 */
export function resetRateLimit(clientId) {
  rateLimitStore.delete(clientId);
}

/**
 * Clear all rate limit data
 */
export function clearRateLimitStore() {
  rateLimitStore.clear();
}

/**
 * Rate limit middleware with Redis backend
 */
export function createRedisRateLimiter(redisClient, options = {}) {
  const {
    limit = RATE_LIMIT_CONFIG.defaultLimit,
    windowMs = RATE_LIMIT_CONFIG.windowMs,
    keyPrefix = 'ratelimit:',
  } = options;

  return async (req, res, next) => {
    const clientId = getClientId(req);
    const key = `${keyPrefix}${clientId}`;

    try {
      const now = Date.now();
      const windowStart = now - windowMs;

      // Get current count
      const currentCount = await redisClient.zCount(key, windowStart, now);

      // Check if blocked
      const blockedUntil = await redisClient.get(`${key}:blocked`);
      if (blockedUntil && now < parseInt(blockedUntil)) {
        res.setHeader('X-RateLimit-Limit', limit);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', Math.ceil(parseInt(blockedUntil) / 1000));
        res.setHeader('Retry-After', Math.ceil((parseInt(blockedUntil) - now) / 1000));
        res.status(429).json({
          error: 'Rate limit exceeded',
          message: `Too many requests. Please try again in ${Math.ceil((parseInt(blockedUntil) - now) / 1000)} seconds.`,
        });
        return;
      }

      // Check if limit exceeded
      if (currentCount >= limit) {
        // Calculate backoff
        const retryCount = parseInt(await redisClient.get(`${key}:retryCount`) || '0');
        const backoffMs = Math.min(
          windowMs * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, retryCount),
          3600 * 1000
        );

        const blockedUntilTime = now + backoffMs;

        await redisClient.set(`${key}:blocked`, blockedUntilTime, 'EX', Math.ceil(backoffMs / 1000));
        await redisClient.set(`${key}:retryCount`, retryCount + 1, 'EX', Math.ceil(backoffMs / 1000));

        res.setHeader('X-RateLimit-Limit', limit);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', Math.ceil(blockedUntilTime / 1000));
        res.setHeader('Retry-After', Math.ceil(backoffMs / 1000));
        res.status(429).json({
          error: 'Rate limit exceeded',
          message: `Too many requests. Please try again in ${Math.ceil(backoffMs / 1000)} seconds.`,
          retryAfter: Math.ceil(backoffMs / 1000),
          blocked: true,
        });
        return;
      }

      // Record request
      await redisClient.zAdd(key, { score: now, value: `${now}:${crypto.randomUUID()}` });
      await redisClient.expire(key, Math.ceil(windowMs / 1000));
      await redisClient.set(`${key}:retryCount`, '0', 'EX', Math.ceil(windowMs / 1000));

      // Calculate remaining
      const remaining = Math.max(0, limit - currentCount - 1);
      const resetAt = now + windowMs;

      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000));

      next();
    } catch (error) {
      console.error('Redis rate limiting error:', error);
      next(); // Allow request if Redis is unavailable
    }
  };
}

/**
 * Rate limit middleware with sliding window
 */
export function slidingWindowRateLimit(options = {}) {
  const {
    limit = RATE_LIMIT_CONFIG.defaultLimit,
    windowMs = RATE_LIMIT_CONFIG.windowMs,
    slidingWindowMs = 10 * 1000, // 10 seconds
  } = options;

  return (req, res, next) => {
    const clientId = getClientId(req);
    const now = Date.now();

    let clientRecord = rateLimitStore.get(clientId);

    if (!clientRecord) {
      clientRecord = {
        requests: [],
        blockedUntil: null,
        retryCount: 0,
      };
    }

    // Clean old requests (sliding window)
    clientRecord.requests = clientRecord.requests.filter(
      timestamp => timestamp > now - windowMs
    );

    // Check if blocked
    if (clientRecord.blockedUntil && now < clientRecord.blockedUntil) {
      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', Math.ceil(clientRecord.blockedUntil / 1000));
      res.setHeader('Retry-After', Math.ceil((clientRecord.blockedUntil - now) / 1000));

      res.status(429).json({
        error: 'Rate limit exceeded',
        message: `Too many requests. Please try again in ${Math.ceil((clientRecord.blockedUntil - now) / 1000)} seconds.`,
      });
      return;
    }

    // Check sliding window (last slidingWindowMs)
    const slidingWindowStart = now - slidingWindowMs;
    const slidingWindowRequests = clientRecord.requests.filter(
      timestamp => timestamp > slidingWindowStart
    );

    // If sliding window exceeded, apply stricter limit
    if (slidingWindowRequests.length >= limit / 2) {
      const backoffMs = Math.min(
        windowMs * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, clientRecord.retryCount),
        60 * 1000
      );

      clientRecord.blockedUntil = now + backoffMs;
      clientRecord.retryCount++;
      rateLimitStore.set(clientId, clientRecord);

      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', Math.ceil(clientRecord.blockedUntil / 1000));
      res.setHeader('Retry-After', Math.ceil(backoffMs / 1000));

      res.status(429).json({
        error: 'Rate limit exceeded',
        message: `Too many requests. Please try again in ${Math.ceil(backoffMs / 1000)} seconds.`,
        retryAfter: Math.ceil(backoffMs / 1000),
        blocked: true,
      });
      return;
    }

    // Record request
    clientRecord.requests.push(now);
    rateLimitStore.set(clientId, clientRecord);

    // Calculate remaining
    const remaining = Math.max(0, limit - clientRecord.requests.length);
    const resetAt = now + windowMs;

    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000));

    next();
  };
}

/**
 * Rate limit middleware with burst protection
 */
export function burstRateLimit(options = {}) {
  const {
    limit = RATE_LIMIT_CONFIG.defaultLimit,
    windowMs = RATE_LIMIT_CONFIG.windowMs,
    burstLimit = 10,
    burstWindowMs = 1000, // 1 second
  } = options;

  return (req, res, next) => {
    const clientId = getClientId(req);
    const now = Date.now();

    let clientRecord = rateLimitStore.get(clientId);

    if (!clientRecord) {
      clientRecord = {
        requests: [],
        burstRequests: [],
        blockedUntil: null,
        retryCount: 0,
      };
    }

    // Clean old requests
    clientRecord.requests = clientRecord.requests.filter(
      timestamp => timestamp > now - windowMs
    );
    clientRecord.burstRequests = clientRecord.burstRequests.filter(
      timestamp => timestamp > now - burstWindowMs
    );

    // Check burst limit
    if (clientRecord.burstRequests.length >= burstLimit) {
      const backoffMs = Math.min(
        windowMs * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, clientRecord.retryCount),
        60 * 1000
      );

      clientRecord.blockedUntil = now + backoffMs;
      clientRecord.retryCount++;
      rateLimitStore.set(clientId, clientRecord);

      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', Math.ceil(clientRecord.blockedUntil / 1000));
      res.setHeader('Retry-After', Math.ceil(backoffMs / 1000));

      res.status(429).json({
        error: 'Rate limit exceeded',
        message: `Too many requests. Please try again in ${Math.ceil(backoffMs / 1000)} seconds.`,
        retryAfter: Math.ceil(backoffMs / 1000),
        blocked: true,
      });
      return;
    }

    // Record burst request
    clientRecord.burstRequests.push(now);

    // Check overall limit
    if (clientRecord.requests.length >= limit) {
      const backoffMs = Math.min(
        windowMs * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, clientRecord.retryCount),
        3600 * 1000
      );

      clientRecord.blockedUntil = now + backoffMs;
      clientRecord.retryCount++;
      rateLimitStore.set(clientId, clientRecord);

      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', Math.ceil(clientRecord.blockedUntil / 1000));
      res.setHeader('Retry-After', Math.ceil(backoffMs / 1000));

      res.status(429).json({
        error: 'Rate limit exceeded',
        message: `Too many requests. Please try again in ${Math.ceil(backoffMs / 1000)} seconds.`,
        retryAfter: Math.ceil(backoffMs / 1000),
        blocked: true,
      });
      return;
    }

    // Record request
    clientRecord.requests.push(now);
    rateLimitStore.set(clientId, clientRecord);

    // Calculate remaining
    const remaining = Math.max(0, limit - clientRecord.requests.length);
    const resetAt = now + windowMs;

    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000));

    next();
  };
}

export default {
  checkRateLimit,
  rateLimitMiddleware,
  rateLimitByKey,
  rateLimitForRoutes,
  getRateLimitStatus,
  resetRateLimit,
  clearRateLimitStore,
  createRedisRateLimiter,
  slidingWindowRateLimit,
  burstRateLimit,
  RATE_LIMIT_CONFIG,
};

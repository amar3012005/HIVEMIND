/**
 * =============================================================================
 * HIVE-MIND Rate Limiting Middleware
 * =============================================================================
 * Purpose: Prevent abuse and DoS attacks
 * Requirements:
 *   - 100 requests/minute per user
 *   - 1000 requests/minute per organization
 *   - Stricter limits for sensitive endpoints
 * Compliance: NIS2 (Availability), DORA (Resilience)
 * =============================================================================
 */

const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const { logger } = require('../core/utils/logger');
const { auditLog } = require('../audit/logger');

// Configuration
const RATE_LIMIT_CONFIG = {
  // User-level limits
  user: {
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    message: {
      error: 'Too many requests',
      message: 'You have exceeded the rate limit. Please try again later.',
      retryAfter: 60,
    },
  },
  
  // Organization-level limits
  org: {
    windowMs: 60 * 1000,
    max: 1000, // 1000 requests per minute per org
    message: {
      error: 'Too many requests',
      message: 'Your organization has exceeded the rate limit.',
      retryAfter: 60,
    },
  },
  
  // Strict limits for sensitive endpoints
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per 15 minutes
    message: {
      error: 'Too many attempts',
      message: 'Too many login attempts. Please try again later.',
      retryAfter: 900,
    },
  },
  
  // GDPR endpoints (prevent abuse)
  gdpr: {
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    max: 5, // 5 export requests per day
    message: {
      error: 'Rate limit exceeded',
      message: 'You have exceeded the daily limit for export requests.',
      retryAfter: 86400,
    },
  },
  
  // API general limit
  api: {
    windowMs: 60 * 1000,
    max: 500, // 500 requests per minute
    message: {
      error: 'Too many requests',
      message: 'API rate limit exceeded.',
      retryAfter: 60,
    },
  },
};

// Redis store for distributed rate limiting
let redisStore;

/**
 * Initialize Redis store for rate limiting
 * @param {Object} redisClient - Redis client instance
 */
function initRedisStore(redisClient) {
  redisStore = new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
  });
  logger.info('Rate limiting Redis store initialized');
}

/**
 * Create rate limiter with custom configuration
 * @param {Object} config - Rate limit configuration
 * @returns {Function} Rate limiting middleware
 */
function createRateLimiter(config) {
  const options = {
    windowMs: config.windowMs,
    max: config.max,
    message: config.message,
    standardHeaders: true, // Return rate limit info in headers
    legacyHeaders: false,
    
    // Custom key generator
    keyGenerator: (req) => {
      // Use user ID if authenticated
      if (req.user?.id) {
        return `user:${req.user.id}`;
      }
      
      // Fall back to IP address
      return `ip:${req.ip}`;
    },
    
    // Skip rate limiting for certain requests
    skip: (req) => {
      // Skip for health checks
      if (req.path === '/health' || req.path === '/ready') {
        return true;
      }
      
      // Skip for internal service requests
      if (req.headers['x-internal-request']) {
        return true;
      }
      
      return false;
    },
    
    // Handler when limit is exceeded
    handler: async (req, res, next, options) => {
      const retryAfter = Math.ceil(options.windowMs / 1000);
      
      // Log rate limit exceeded
      logger.warn('Rate limit exceeded', {
        ip: req.ip,
        path: req.path,
        method: req.method,
        userId: req.user?.id,
        userAgent: req.headers['user-agent'],
      });

      // Audit log for security monitoring
      await auditLog({
        eventType: 'rate_limit_exceeded',
        eventCategory: 'security',
        resourceType: 'system',
        action: 'read',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        platformType: req.headers['x-platform-type'],
        sessionId: req.headers['x-session-id'],
        processingBasis: 'GDPR Article 6(1)(f) - Legitimate interest (security)',
        legalBasisNote: `Rate limit exceeded: ${req.path}`,
      }).catch(() => {});

      res.status(429).json({
        ...options.message,
        retryAfter,
      });
    },
  };

  // Use Redis store if available
  if (redisStore) {
    options.store = redisStore;
  }

  return rateLimit(options);
}

/**
 * User rate limiter (100 req/min)
 */
const userRateLimiter = createRateLimiter(RATE_LIMIT_CONFIG.user);

/**
 * Organization rate limiter (1000 req/min)
 */
const orgRateLimiter = createRateLimiter(RATE_LIMIT_CONFIG.org);

/**
 * Auth rate limiter (10 attempts per 15 min)
 */
const authRateLimiter = createRateLimiter(RATE_LIMIT_CONFIG.auth);

/**
 * GDPR rate limiter (5 requests per day)
 */
const gdprRateLimiter = createRateLimiter(RATE_LIMIT_CONFIG.gdpr);

/**
 * API rate limiter (500 req/min)
 */
const apiRateLimiter = createRateLimiter(RATE_LIMIT_CONFIG.api);

/**
 * Strict rate limiter for sensitive operations
 * @param {number} maxRequests - Maximum requests
 * @param {number} windowMinutes - Window in minutes
 */
function createStrictLimiter(maxRequests, windowMinutes = 1) {
  return createRateLimiter({
    windowMs: windowMinutes * 60 * 1000,
    max: maxRequests,
    message: {
      error: 'Too many requests',
      message: `Maximum ${maxRequests} requests allowed per ${windowMinutes} minute(s).`,
      retryAfter: windowMinutes * 60,
    },
  });
}

/**
 * Sliding window rate limiter
 * More accurate than fixed window
 * @param {Object} options - Rate limit options
 */
function slidingWindowLimiter(options) {
  const { windowMs, max, keyPrefix = 'sliding' } = options;
  
  return async (req, res, next) => {
    if (!redisStore) {
      logger.warn('Redis not available for sliding window rate limiting');
      return next();
    }

    const key = `${keyPrefix}:${req.user?.id || req.ip}:${Math.floor(Date.now() / windowMs)}`;
    
    try {
      const current = await redisStore.increment(key);
      
      if (current > max) {
        return res.status(429).json({
          error: 'Too many requests',
          message: 'Rate limit exceeded',
        });
      }
      
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', max - current);
      
      next();
    } catch (error) {
      logger.error('Sliding window rate limit error', { error: error.message });
      next();
    }
  };
}

/**
 * Token bucket rate limiter
 * Allows bursts while maintaining average rate
 * @param {Object} options - Rate limit options
 */
function tokenBucketLimiter(options) {
  const { tokensPerSecond, maxTokens, keyPrefix = 'bucket' } = options;
  
  return async (req, res, next) => {
    if (!redisStore) {
      return next();
    }

    const key = `${keyPrefix}:${req.user?.id || req.ip}`;
    const now = Date.now();
    
    try {
      // Get current bucket state
      const bucket = await redisStore.get(key);
      let tokens, lastUpdate;
      
      if (bucket) {
        [tokens, lastUpdate] = bucket.split(':').map(Number);
        // Add tokens based on time elapsed
        const elapsed = (now - lastUpdate) / 1000;
        tokens = Math.min(maxTokens, tokens + elapsed * tokensPerSecond);
      } else {
        tokens = maxTokens;
        lastUpdate = now;
      }
      
      if (tokens < 1) {
        return res.status(429).json({
          error: 'Too many requests',
          message: 'Rate limit exceeded',
        });
      }
      
      // Consume token
      tokens -= 1;
      await redisStore.set(key, `${tokens}:${now}`, 'PX', 60000);
      
      res.setHeader('X-RateLimit-Limit', maxTokens);
      res.setHeader('X-RateLimit-Remaining', Math.floor(tokens));
      
      next();
    } catch (error) {
      logger.error('Token bucket rate limit error', { error: error.message });
      next();
    }
  };
}

/**
 * Rate limit status endpoint
 * Returns current rate limit status for the user
 */
async function getRateLimitStatus(req) {
  if (!redisStore) {
    return { available: false };
  }

  const key = `user:${req.user?.id || req.ip}`;
  
  try {
    const count = await redisStore.get(key);
    
    return {
      available: true,
      current: count || 0,
      limit: RATE_LIMIT_CONFIG.user.max,
      remaining: Math.max(0, RATE_LIMIT_CONFIG.user.max - (count || 0)),
      resetIn: Math.ceil(RATE_LIMIT_CONFIG.user.windowMs / 1000),
    };
  } catch (error) {
    logger.error('Rate limit status error', { error: error.message });
    return { available: false, error: error.message };
  }
}

/**
 * Reset rate limit for a user
 * @param {string} userId - User ID
 */
async function resetRateLimit(userId) {
  if (!redisStore) {
    return false;
  }

  try {
    const key = `user:${userId}`;
    await redisStore.delete(key);
    logger.info('Rate limit reset', { userId });
    return true;
  } catch (error) {
    logger.error('Rate limit reset error', { error: error.message });
    return false;
  }
}

module.exports = {
  // Pre-configured limiters
  userRateLimiter,
  orgRateLimiter,
  authRateLimiter,
  gdprRateLimiter,
  apiRateLimiter,
  
  // Factory functions
  createRateLimiter,
  createStrictLimiter,
  slidingWindowLimiter,
  tokenBucketLimiter,
  
  // Utilities
  initRedisStore,
  getRateLimitStatus,
  resetRateLimit,
  
  // Configuration
  RATE_LIMIT_CONFIG,
};

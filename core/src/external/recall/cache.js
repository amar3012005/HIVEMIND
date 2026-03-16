/**
 * Recall Cache
 * 
 * Caches recall results for improved performance
 * Implements LRU eviction and TTL-based expiration
 * 
 * @module recall/cache
 */

// Logger
const logger = {
  info: (msg, ctx) => console.log(`[CACHE INFO] ${msg}`, ctx),
  warn: (msg, ctx) => console.warn(`[CACHE WARN] ${msg}`, ctx),
  error: (msg, ctx) => console.error(`[CACHE ERROR] ${msg}`, ctx)
};

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // Cache TTL in milliseconds
  defaultTTL: 5 * 60 * 1000, // 5 minutes
  contextTTL: 2 * 60 * 1000, // 2 minutes for context
  searchTTL: 3 * 60 * 1000, // 3 minutes for search

  // Max cache size (entries)
  maxEntries: 1000,
  maxEntriesPerUser: 100,

  // Eviction settings
  evictionBatchSize: 50,
  evictionCheckInterval: 60 * 1000, // Check every minute

  // Key prefixes
  prefixes: {
    search: 'recall:search:',
    context: 'recall:context:',
    memory: 'recall:memory:',
    user: 'recall:user:'
  }
};

// ==========================================
// In-Memory Cache Implementation
// ==========================================

class MemoryCache {
  constructor(options = {}) {
    this.maxEntries = options.maxEntries || CONFIG.maxEntries;
    this.defaultTTL = options.defaultTTL || CONFIG.defaultTTL;
    this.store = new Map();
    this.accessOrder = new Map(); // For LRU
    this.evictionTimer = null;

    // Start eviction checker
    this.startEvictionChecker();
  }

  /**
   * Generate cache key
   */
  generateKey(prefix, ...parts) {
    return `${prefix}${parts.join(':')}`;
  }

  /**
   * Set cache entry
   */
  set(key, value, ttl = null) {
    const expiresAt = Date.now() + (ttl || this.defaultTTL);
    
    // Check if we need to evict
    if (this.store.size >= this.maxEntries) {
      this.evictLRU();
    }

    this.store.set(key, {
      value,
      expiresAt,
      createdAt: Date.now(),
      size: JSON.stringify(value).length
    });

    // Update access order
    this.accessOrder.delete(key);
    this.accessOrder.set(key, Date.now());

    logger.info('Cache set', { key, ttl, size: this.store.size });
  }

  /**
   * Get cache entry
   */
  get(key) {
    const entry = this.store.get(key);
    
    if (!entry) {
      return null;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return null;
    }

    // Update access time
    this.accessOrder.delete(key);
    this.accessOrder.set(key, Date.now());

    logger.info('Cache hit', { key });
    return entry.value;
  }

  /**
   * Delete cache entry
   */
  delete(key) {
    this.store.delete(key);
    this.accessOrder.delete(key);
    logger.info('Cache delete', { key });
  }

  /**
   * Check if key exists
   */
  has(key) {
    const entry = this.store.get(key);
    if (!entry) return false;
    
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * Evict least recently used entries
   */
  evictLRU(count = CONFIG.evictionBatchSize) {
    const keysToDelete = [];
    
    for (const [key] of this.accessOrder.entries()) {
      keysToDelete.push(key);
      if (keysToDelete.length >= count) break;
    }

    keysToDelete.forEach(key => this.delete(key));

    logger.warn('Cache eviction', { count: keysToDelete.length });
  }

  /**
   * Evict expired entries
   */
  evictExpired() {
    const now = Date.now();
    const expiredKeys = [];

    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        expiredKeys.push(key);
      }
    }

    expiredKeys.forEach(key => this.delete(key));

    if (expiredKeys.length > 0) {
      logger.info('Expired entries evicted', { count: expiredKeys.length });
    }
  }

  /**
   * Clear all entries
   */
  clear() {
    this.store.clear();
    this.accessOrder.clear();
    logger.info('Cache cleared');
  }

  /**
   * Get cache stats
   */
  getStats() {
    const now = Date.now();
    let expiredCount = 0;
    let totalSize = 0;

    for (const entry of this.store.values()) {
      if (now > entry.expiresAt) expiredCount++;
      totalSize += entry.size;
    }

    return {
      size: this.store.size,
      expiredCount,
      activeCount: this.store.size - expiredCount,
      totalSizeBytes: totalSize,
      totalSizeKB: Math.round(totalSize / 1024),
      maxEntries: this.maxEntries,
      utilization: (this.store.size / this.maxEntries * 100).toFixed(2) + '%'
    };
  }

  /**
   * Start eviction checker
   */
  startEvictionChecker() {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
    }

    this.evictionTimer = setInterval(() => {
      this.evictExpired();
    }, CONFIG.evictionCheckInterval);

    logger.info('Eviction checker started');
  }

  /**
   * Stop eviction checker
   */
  stopEvictionChecker() {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
  }
}

// ==========================================
// Global Cache Instance
// ==========================================

let globalCache = null;

/**
 * Get or create global cache instance
 */
export function getCache() {
  if (!globalCache) {
    globalCache = new MemoryCache();
  }
  return globalCache;
}

// ==========================================
// Cache Operations
// ==========================================

/**
 * Cache search results
 */
export function cacheSearchResults(userId, query, results, ttl = null) {
  const cache = getCache();
  const key = cache.generateKey(
    CONFIG.prefixes.search,
    userId,
    Buffer.from(query).toString('base64')
  );

  cache.set(key, {
    results,
    query,
    cachedAt: new Date()
  }, ttl || CONFIG.searchTTL);
}

/**
 * Get cached search results
 */
export function getCachedSearchResults(userId, query) {
  const cache = getCache();
  const key = cache.generateKey(
    CONFIG.prefixes.search,
    userId,
    Buffer.from(query).toString('base64')
  );

  return cache.get(key);
}

/**
 * Cache context injection result
 */
export function cacheContext(conversationId, context, ttl = null) {
  const cache = getCache();
  const key = cache.generateKey(
    CONFIG.prefixes.context,
    conversationId
  );

  cache.set(key, {
    context,
    cachedAt: new Date()
  }, ttl || CONFIG.contextTTL);
}

/**
 * Get cached context
 */
export function getCachedContext(conversationId) {
  const cache = getCache();
  const key = cache.generateKey(
    CONFIG.prefixes.context,
    conversationId
  );

  return cache.get(key);
}

/**
 * Cache single memory
 */
export function cacheMemory(memoryId, memory, ttl = null) {
  const cache = getCache();
  const key = cache.generateKey(
    CONFIG.prefixes.memory,
    memoryId
  );

  cache.set(key, memory, ttl || CONFIG.defaultTTL);
}

/**
 * Get cached memory
 */
export function getCachedMemory(memoryId) {
  const cache = getCache();
  const key = cache.generateKey(
    CONFIG.prefixes.memory,
    memoryId
  );

  return cache.get(key);
}

/**
 * Invalidate user cache
 */
export function invalidateUserCache(userId) {
  const cache = getCache();
  const prefix = cache.generateKey(CONFIG.prefixes.user, userId);
  
  // Delete all keys starting with user prefix
  for (const key of cache.store.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }

  logger.info('User cache invalidated', { userId });
}

/**
 * Invalidate specific cache type
 */
export function invalidateCacheType(type, userId = null) {
  const cache = getCache();
  const prefix = cache.generateKey(CONFIG.prefixes[type] || type);
  
  for (const key of cache.store.keys()) {
    if (userId && !key.includes(userId)) continue;
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }

  logger.info('Cache type invalidated', { type, userId });
}

// ==========================================
// Cache-Aside Pattern
// ==========================================

/**
 * Get from cache or compute and cache
 */
export async function cacheAside(key, computeFn, ttl = null) {
  const cache = getCache();
  
  // Try cache first
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  // Compute and cache
  const result = await computeFn();
  cache.set(key, result, ttl);
  
  return result;
}

/**
 * Cache with refresh on expiration
 */
export async function cacheWithRefresh(key, computeFn, ttl = null) {
  const cache = getCache();
  const entry = cache.store.get(key);

  if (!entry) {
    // Not in cache, compute
    const result = await computeFn();
    cache.set(key, result, ttl);
    return result;
  }

  // Check if expired or expiring soon (within 30 seconds)
  const now = Date.now();
  const soonToExpire = entry.expiresAt - now < 30 * 1000;

  if (soonToExpire) {
    // Refresh in background
    computeFn().then(result => {
      cache.set(key, result, ttl);
    }).catch(err => {
      logger.error('Background cache refresh failed', { key, error: err.message });
    });
  }

  return entry.value;
}

// ==========================================
// Multi-Level Cache
// ==========================================

/**
 * Multi-level cache with Redis fallback
 */
export class MultiLevelCache {
  constructor(options = {}) {
    this.memoryCache = new MemoryCache(options.memory);
    this.redisClient = options.redisClient || null;
    this.keyPrefix = options.keyPrefix || 'hivemind:';
  }

  generateKey(...parts) {
    return this.keyPrefix + parts.join(':');
  }

  async get(key) {
    // Try memory first
    const memoryKey = this.memoryCache.generateKey(key);
    const memoryResult = this.memoryCache.get(memoryKey);
    if (memoryResult) {
      return memoryResult;
    }

    // Try Redis
    if (this.redisClient) {
      try {
        const redisKey = this.generateKey(key);
        const data = await this.redisClient.get(redisKey);
        
        if (data) {
          const parsed = JSON.parse(data);
          // Populate memory cache
          this.memoryCache.set(memoryKey, parsed);
          return parsed;
        }
      } catch (error) {
        logger.error('Redis get failed', { key, error: error.message });
      }
    }

    return null;
  }

  async set(key, value, ttl = null) {
    const memoryKey = this.memoryCache.generateKey(key);
    
    // Set in memory
    this.memoryCache.set(memoryKey, value, ttl);

    // Set in Redis
    if (this.redisClient) {
      try {
        const redisKey = this.generateKey(key);
        const serialized = JSON.stringify(value);
        
        if (ttl) {
          await this.redisClient.setex(redisKey, Math.floor(ttl / 1000), serialized);
        } else {
          await this.redisClient.set(redisKey, serialized);
        }
      } catch (error) {
        logger.error('Redis set failed', { key, error: error.message });
      }
    }
  }

  async delete(key) {
    const memoryKey = this.memoryCache.generateKey(key);
    this.memoryCache.delete(memoryKey);

    if (this.redisClient) {
      try {
        const redisKey = this.generateKey(key);
        await this.redisClient.del(redisKey);
      } catch (error) {
        logger.error('Redis delete failed', { key, error: error.message });
      }
    }
  }

  getStats() {
    return {
      memory: this.memoryCache.getStats(),
      redis: this.redisClient ? 'connected' : 'not configured'
    };
  }
}

// ==========================================
// Express Middleware
// ==========================================

/**
 * Cache middleware for recall endpoints
 */
export function recallCacheMiddleware(options = {}) {
  const { ttl = CONFIG.searchTTL, keyGenerator = null } = options;

  return (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    const cache = getCache();
    const userId = req.user?.id || 'anonymous';
    
    // Generate cache key
    const cacheKey = keyGenerator 
      ? keyGenerator(req)
      : cache.generateKey(
          CONFIG.prefixes.search,
          userId,
          Buffer.from(JSON.stringify(req.query)).toString('base64')
        );

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      logger.info('Cache hit', { key: cacheKey });
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Age', Math.floor((Date.now() - cached.cachedAt) / 1000));
      return res.json(cached);
    }

    // Override res.json to cache response
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      cache.set(cacheKey, {
        ...data,
        cachedAt: new Date()
      }, ttl);
      
      res.setHeader('X-Cache', 'MISS');
      return originalJson(data);
    };

    next();
  };
}

// ==========================================
// Exports
// ==========================================

export default {
  MemoryCache,
  MultiLevelCache,
  getCache,
  cacheSearchResults,
  getCachedSearchResults,
  cacheContext,
  getCachedContext,
  cacheMemory,
  getCachedMemory,
  invalidateUserCache,
  invalidateCacheType,
  cacheAside,
  cacheWithRefresh,
  recallCacheMiddleware,
  CONFIG
};

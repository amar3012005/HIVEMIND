/**
 * Mistral-Embed Integration Service
 *
 * Provides embedding generation using Mistral AI's mistral-embed model
 * Implements batch processing, retry logic, and caching
 *
 * @module embeddings/mistral
 * @description EU Sovereign: Uses Mistral AI EU endpoint for data residency
 */

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // Mistral API configuration
  api: {
    endpoint: 'https://api.mistral.ai/v1',
    euEndpoint: 'https://api.mistral.ai/v1', // EU data residency
    model: 'mistral-embed',
    batchSize: 100,
    maxRetries: 3,
    timeout: 30000 // 30 seconds
  },

  // Cache configuration
  cache: {
    enabled: true,
    ttl: 86400, // 24 hours in seconds
    maxSize: 100000,
    keyPrefix: 'mistral:embed:'
  },

  // Input validation
  validation: {
    maxTextLength: 8192,
    minTextLength: 1,
    maxBatchSize: 100
  },

  // Metrics tracking
  metrics: {
    enabled: true,
    endpoint: '/metrics/embeddings'
  }
};

// ==========================================
// In-Memory Cache Implementation
// ==========================================

class EmbeddingCache {
  constructor(options = {}) {
    this.ttl = options.ttl || CONFIG.cache.ttl;
    this.maxSize = options.maxSize || CONFIG.cache.maxSize;
    this.prefix = options.prefix || CONFIG.cache.keyPrefix;
    this.store = new Map();
    this.accessOrder = new Map();
    this.evictionTimer = null;
    this.stats = {
      hits: 0,
      misses: 0,
      size: 0
    };

    this.startEvictionChecker();
  }

  /**
   * Generate cache key from text
   */
  generateKey(text) {
    // Simple hash for cache key
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `${this.prefix}${Math.abs(hash).toString(36)}`;
  }

  /**
   * Store embedding in cache
   */
  set(text, embedding) {
    const key = this.generateKey(text);

    // Evict if at capacity
    if (this.store.size >= this.maxSize) {
      this.evictLRU();
    }

    this.store.set(key, {
      embedding,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttl * 1000,
      textHash: this.generateKey(text)
    });

    // Update access order
    this.accessOrder.delete(key);
    this.accessOrder.set(key, Date.now());

    this.stats.size = this.store.size;
  }

  /**
   * Get embedding from cache
   */
  get(text) {
    const key = this.generateKey(text);
    const entry = this.store.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      this.stats.misses++;
      return null;
    }

    // Update access time
    this.accessOrder.delete(key);
    this.accessOrder.set(key, Date.now());
    this.stats.hits++;

    return entry.embedding;
  }

  /**
   * Delete entry from cache
   */
  delete(text) {
    const key = this.generateKey(text);
    this.store.delete(key);
    this.accessOrder.delete(key);
    this.stats.size = this.store.size;
  }

  /**
   * Check if cache has entry
   */
  has(text) {
    const key = this.generateKey(text);
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
  evictLRU(count = 100) {
    const keysToDelete = [];

    for (const [key] of this.accessOrder.entries()) {
      keysToDelete.push(key);
      if (keysToDelete.length >= count) break;
    }

    keysToDelete.forEach(key => this.delete(key));
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
  }

  /**
   * Clear all cache entries
   */
  clear() {
    this.store.clear();
    this.accessOrder.clear();
    this.stats = { hits: 0, misses: 0, size: 0 };
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const now = Date.now();
    let expiredCount = 0;

    for (const entry of this.store.values()) {
      if (now > entry.expiresAt) expiredCount++;
    }

    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0;

    return {
      size: this.store.size,
      maxSize: this.maxSize,
      utilization: ((this.store.size / this.maxSize) * 100).toFixed(2) + '%',
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: hitRate + '%',
      expiredCount,
      ttlSeconds: this.ttl
    };
  }

  /**
   * Start automatic eviction checker
   */
  startEvictionChecker() {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
    }

    this.evictionTimer = setInterval(() => {
      this.evictExpired();
    }, 60000); // Check every minute
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
// Logger
// ==========================================

const logger = {
  info: (msg, ctx) => console.log(`[EMBED INFO] ${msg}`, ctx || {}),
  warn: (msg, ctx) => console.warn(`[EMBED WARN] ${msg}`, ctx || {}),
  error: (msg, ctx) => console.error(`[EMBED ERROR] ${msg}`, ctx || {}),
  debug: (msg, ctx) => console.debug(`[EMBED DEBUG] ${msg}`, ctx || {})
};

// ==========================================
// MistralEmbed Service
// ==========================================

export class MistralEmbedService {
  constructor(config = {}) {
    this.config = {
      ...CONFIG.api,
      ...config,
      apiKey: config.apiKey || process.env.MISTRAL_API_KEY
    };

    this.cache = new EmbeddingCache(CONFIG.cache);
    this.tokenUsage = {
      promptTokens: 0,
      totalTokens: 0
    };
    this.requestCount = 0;
    this.errorCount = 0;
  }

  /**
   * Validate text input
   */
  validateText(text) {
    if (typeof text !== 'string') {
      throw new Error('Text must be a string');
    }

    const trimmed = text.trim();
    if (trimmed.length < CONFIG.validation.minTextLength) {
      throw new Error(`Text must be at least ${CONFIG.validation.minTextLength} characters`);
    }

    if (trimmed.length > CONFIG.validation.maxTextLength) {
      throw new Error(`Text exceeds maximum length of ${CONFIG.validation.maxTextLength} characters`);
    }

    return trimmed;
  }

  /**
   * Generate embedding for single text
   */
  async embed(text, options = {}) {
    const startTime = Date.now();

    // Validate input
    const validatedText = this.validateText(text);

    // Check cache first
    if (this.config.cache.enabled && this.cache.has(validatedText)) {
      const cachedEmbedding = this.cache.get(validatedText);
      logger.debug('Embedding cache hit', {
        textLength: validatedText.length,
        cacheKey: this.cache.generateKey(validatedText)
      });
      return {
        embedding: cachedEmbedding,
        model: this.config.model,
        latencyMs: Date.now() - startTime,
        cached: true
      };
    }

    // Make API request with retry
    let lastError = null;
    let retryCount = 0;

    while (retryCount <= this.config.maxRetries) {
      try {
        const result = await this.makeEmbeddingRequest(validatedText);
        this.requestCount++;

        // Cache result
        if (this.config.cache.enabled) {
          this.cache.set(validatedText, result.embedding);
        }

        // Update token usage
        this.tokenUsage.promptTokens += result.usage.prompt_tokens;
        this.tokenUsage.totalTokens += result.usage.total_tokens;

        logger.debug('Embedding generated', {
          textLength: validatedText.length,
          dimension: result.embedding.length,
          tokens: result.usage.total_tokens,
          latencyMs: Date.now() - startTime
        });

        return {
          embedding: result.embedding,
          model: result.model,
          latencyMs: Date.now() - startTime,
          cached: false,
          tokens: result.usage.total_tokens
        };
      } catch (error) {
        lastError = error;
        retryCount++;

        if (retryCount <= this.config.maxRetries) {
          const backoffDelay = Math.pow(2, retryCount) * 1000;
          logger.warn(`Embedding request failed, retrying in ${backoffDelay}ms`, {
            attempt: retryCount,
            error: error.message
          });
          await this.sleep(backoffDelay);
        } else {
          this.errorCount++;
          logger.error('Embedding failed after all retries', {
            textLength: validatedText.length,
            error: lastError.message
          });
          throw lastError;
        }
      }
    }

    throw lastError;
  }

  /**
   * Generate embeddings for batch of texts
   */
  async embedBatch(texts, options = {}) {
    const startTime = Date.now();

    // Validate inputs
    if (!Array.isArray(texts) || texts.length === 0) {
      return {
        embeddings: [],
        model: this.config.model,
        latencyMs: 0,
        tokens: 0
      };
    }

    if (texts.length > CONFIG.validation.maxBatchSize) {
      throw new Error(`Batch size exceeds maximum of ${CONFIG.validation.maxBatchSize}`);
    }

    // Check cache for each text
    const cachedIndices = [];
    const cachedEmbeddings = new Array(texts.length).fill(null);
    const textsToEmbed = [];
    const indicesToEmbed = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const validatedText = this.validateText(text);

      if (this.config.cache.enabled && this.cache.has(validatedText)) {
        cachedIndices.push(i);
        cachedEmbeddings[i] = this.cache.get(validatedText);
      } else {
        textsToEmbed.push(validatedText);
        indicesToEmbed.push(i);
      }
    }

    logger.debug('Batch embedding cache check', {
      total: texts.length,
      cached: cachedIndices.length,
      toEmbed: textsToEmbed.length
    });

    // If all cached, return early
    if (textsToEmbed.length === 0) {
      return {
        embeddings: cachedEmbeddings,
        model: this.config.model,
        latencyMs: Date.now() - startTime,
        tokens: 0,
        cached: true
      };
    }

    // Process in batches
    const batchSize = this.config.batchSize;
    const allEmbeddings = [...cachedEmbeddings];
    let totalTokens = 0;

    for (let i = 0; i < textsToEmbed.length; i += batchSize) {
      const batch = textsToEmbed.slice(i, i + batchSize);
      const batchIndices = indicesToEmbed.slice(i, i + batchSize);

      let lastError = null;
      let retryCount = 0;

      while (retryCount <= this.config.maxRetries) {
        try {
          const result = await this.makeEmbeddingRequest(batch);

          // Map embeddings back to original indices
          for (let j = 0; j < batch.length; j++) {
            const originalIndex = batchIndices[j];
            allEmbeddings[originalIndex] = result.data[j].embedding;

            // Cache result
            if (this.config.cache.enabled) {
              this.cache.set(textsToEmbed[i + j], result.data[j].embedding);
            }
          }

          totalTokens += result.usage.total_tokens;
          this.requestCount++;

          break;
        } catch (error) {
          lastError = error;
          retryCount++;

          if (retryCount <= this.config.maxRetries) {
            const backoffDelay = Math.pow(2, retryCount) * 1000;
            logger.warn(`Batch embedding failed, retrying in ${backoffDelay}ms`, {
              batchNumber: Math.floor(i / batchSize) + 1,
              attempt: retryCount,
              error: error.message
            });
            await this.sleep(backoffDelay);
          } else {
            this.errorCount++;
            logger.error('Batch embedding failed after all retries', {
              batchNumber: Math.floor(i / batchSize) + 1,
              batchSize: batch.length,
              error: lastError.message
            });
            throw lastError;
          }
        }
      }
    }

    logger.debug('Batch embedding completed', {
      total: texts.length,
      cached: cachedIndices.length,
      processed: textsToEmbed.length,
      tokens: totalTokens,
      latencyMs: Date.now() - startTime
    });

    return {
      embeddings: allEmbeddings,
      model: this.config.model,
      latencyMs: Date.now() - startTime,
      tokens: totalTokens,
      cached: false
    };
  }

  /**
   * Make API request to Mistral
   */
  async makeEmbeddingRequest(input) {
    const body = {
      model: this.config.model,
      input: input
    };

    const response = await fetch(`${this.config.endpoint}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
        'User-Agent': 'hivemind/1.0'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Mistral API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    return {
      model: data.model,
      data: data.data,
      usage: data.usage
    };
  }

  /**
   * Prepare text for embedding with context
   */
  prepareTextForEmbedding(memory) {
    const parts = [];

    // Add memory type prefix for better embedding quality
    if (memory.memoryType) {
      parts.push(`[Type: ${memory.memoryType}]`);
    }

    // Add content
    if (memory.content) {
      parts.push(memory.content);
    }

    // Add tags for context
    if (memory.tags && memory.tags.length > 0) {
      parts.push(`[Tags: ${memory.tags.join(', ')}]`);
    }

    return parts.join(' ');
  }

  /**
   * Process memories for embedding
   */
  async processMemories(memories) {
    const texts = memories.map(m => this.prepareTextForEmbedding(m));
    return this.embedBatch(texts);
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * Get usage statistics
   */
  getUsageStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      tokenUsage: this.tokenUsage,
      cacheStats: this.getCacheStats()
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    logger.info('Embedding cache cleared');
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get model info
   */
  getModelInfo() {
    return {
      name: this.config.model,
      dimension: 1024,
      endpoint: this.config.endpoint,
      euDataResidency: true
    };
  }
}

// ==========================================
// Singleton Pattern
// ==========================================

let mistralEmbedService = null;

/**
 * Get or create MistralEmbedService singleton
 */
export function getMistralEmbedService(config = {}) {
  if (!mistralEmbedService) {
    mistralEmbedService = new MistralEmbedService(config);
  }
  return mistralEmbedService;
}

// ==========================================
// Export
// ==========================================

export default {
  MistralEmbedService,
  getMistralEmbedService,
  CONFIG,
  EmbeddingCache
};

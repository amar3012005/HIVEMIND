/**
 * Pre-Embedding Situationalizer
 * Uses Groq API (llama-3.3-70b-versatile) to generate one-sentence context
 * before vector embedding, addressing context fragmentation in RAG
 *
 * Reference: https://supermemory.ai/blog/contextual-retrieval/
 *
 * @module situationalizer
 * @description Contextual Retrieval Pipeline - Pre-Embedding Situationalizer
 */

import { getGroqClient } from '../core/config/groq.js';

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // Groq API configuration
  groq: {
    model: process.env.SITUATIONALIZER_MODEL || 'llama-3-3-70b-versatile',
    temperature: 0.3, // Low temp for factual consistency
    maxTokens: 150,
    timeout: 30000, // 30 seconds
    maxRetries: 3
  },

  // Cache configuration
  cache: {
    enabled: true,
    ttl: 3600000, // 1 hour in milliseconds
    maxSize: 50000,
    keyPrefix: 'situationalizer:'
  },

  // Input validation
  validation: {
    maxDocumentSize: 5000, // Characters
    maxChunkSize: 2000, // Characters
    minChunkSize: 10
  },

  // Cost optimization
  batch: {
    maxSize: 100, // Process up to 100 chunks in parallel
    sequentialBatches: true // Process batches sequentially for rate limiting
  }
};

// ==========================================
// In-Memory Cache Implementation
// ==========================================

class SituationalizerCache {
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
   * Generate cache key from context
   */
  generateKey({ source, chunk, fullDocument }) {
    // Simple hash for cache key
    const hash = (str) => {
      let h = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        h = ((h << 5) - h) + char;
        h = h & h;
      }
      return Math.abs(h).toString(36);
    };

    const sourceHash = hash(source || '');
    const chunkHash = hash(chunk.substring(0, 200) || '');
    return `${this.prefix}${sourceHash}:${chunkHash}`;
  }

  /**
   * Store context in cache
   */
  set(key, context) {
    // Evict if at capacity
    if (this.store.size >= this.maxSize) {
      this.evictLRU();
    }

    this.store.set(key, {
      context,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttl,
      key
    });

    // Update access order
    this.accessOrder.delete(key);
    this.accessOrder.set(key, Date.now());

    this.stats.size = this.store.size;
  }

  /**
   * Get context from cache
   */
  get(key) {
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

    return entry.context;
  }

  /**
   * Delete entry from cache
   */
  delete(key) {
    this.store.delete(key);
    this.accessOrder.delete(key);
    this.stats.size = this.store.size;
  }

  /**
   * Check if cache has entry
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
      ttlSeconds: this.ttl / 1000
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
  info: (msg, ctx) => console.log(`[SITU INFO] ${msg}`, ctx || {}),
  warn: (msg, ctx) => console.warn(`[SITU WARN] ${msg}`, ctx || {}),
  error: (msg, ctx) => console.error(`[SITU ERROR] ${msg}`, ctx || {}),
  debug: (msg, ctx) => console.debug(`[SITU DEBUG] ${msg}`, ctx || {})
};

// ==========================================
// Groq Situationalizer Class
// ==========================================

export class GroqSituationalizer {
  constructor(config = {}) {
    this.config = {
      ...CONFIG.groq,
      ...config
    };

    // Accept optional groqClient for testing
    if (config.groqClient) {
      this.groqClient = config.groqClient;
    } else {
      this.groqClient = getGroqClient({
        inferenceModel: this.config.model,
        timeout: this.config.timeout,
        maxRetries: this.config.maxRetries
      });
    }

    this.cache = new SituationalizerCache(CONFIG.cache);
    this.tokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requests: 0
    };
    this.requestCount = 0;
    this.errorCount = 0;
  }

  /**
   * Check if situationalizer is available
   * @returns {boolean}
   */
  isAvailable() {
    return this.groqClient.isAvailable();
  }

  /**
   * Get model name
   * @returns {string}
   */
  getModel() {
    return this.config.model;
  }

  /**
   * Generate situational context for a chunk
   * @param {Object} params
   * @param {string} params.fullDocument - Original document content
   * @param {string} params.chunk - Text chunk to contextualize
   * @param {string} params.source - Document source metadata
   * @param {number} [params.chunkIndex=0] - Chunk position in document
   * @returns {Promise<string>} Situationalized context (one sentence)
   */
  async generateContext({ fullDocument, chunk, source, chunkIndex = 0 }) {
    const cacheKey = this.cache.generateKey({ source, chunk, fullDocument });

    // Check cache first
    if (this.config.cache.enabled && this.cache.has(cacheKey)) {
      const cachedContext = this.cache.get(cacheKey);
      logger.debug('Situationalizer cache hit', {
        source,
        chunkLength: chunk.length,
        cacheKey
      });
      this.tokenUsage.requests++;
      return cachedContext;
    }

    const prompt = this._buildSituationalizerPrompt({
      fullDocument: fullDocument.substring(0, CONFIG.validation.maxDocumentSize),
      chunk: chunk.substring(0, CONFIG.validation.maxChunkSize),
      source,
      chunkIndex
    });

    try {
      const startTime = Date.now();
      const response = await this.groqClient.generate(prompt, {
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens
      });

      const context = response.trim();

      // Validate context format
      const validatedContext = this._validateContext(context);

      // Cache result
      if (this.config.cache.enabled) {
        this.cache.set(cacheKey, validatedContext);
      }

      // Update token usage
      const usage = this.groqClient.getUsage();
      this.tokenUsage.promptTokens += usage.promptTokens;
      this.tokenUsage.completionTokens += usage.completionTokens;
      this.tokenUsage.totalTokens += usage.totalTokens;
      this.tokenUsage.requests++;
      this.requestCount++;

      logger.debug('Situationalizer generated context', {
        source,
        contextLength: validatedContext.length,
        latencyMs: Date.now() - startTime,
        tokens: usage.totalTokens
      });

      return validatedContext;
    } catch (error) {
      this.errorCount++;
      logger.error('Situationalizer failed', {
        source,
        chunkLength: chunk.length,
        error: error.message
      });

      // Fallback: simple template
      return this._fallbackContext({ source, chunk });
    }
  }

  /**
   * Generate situational context for batch of chunks
   * @param {Array} paramsArray - Array of context parameters
   * @returns {Promise<Array>} Array of situationalized contexts
   */
  async generateContextBatch(paramsArray) {
    if (paramsArray.length === 0) {
      return [];
    }

    // Process in batches for rate limiting
    const batchSize = CONFIG.batch.maxSize;
    const results = [];

    for (let i = 0; i < paramsArray.length; i += batchSize) {
      const batch = paramsArray.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(params => this.generateContext(params))
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Build prompt for situationalizer
   */
  _buildSituationalizerPrompt({ fullDocument, chunk, source, chunkIndex }) {
    return `Analyze this text chunk and generate a one-sentence context that situates it within the broader document.

Document Source: ${source}
Chunk Position: ${chunkIndex}

FULL DOCUMENT (for context):
${fullDocument.substring(0, 2000)}

TEXT CHUNK TO CONTEXTUALIZE:
"${chunk}"

INSTRUCTIONS:
1. Identify the document type (report, code, conversation, documentation, etc.)
2. Extract the main topic or purpose
3. Describe how this chunk relates to the overall document
4. Output exactly ONE sentence in this format:
   "This is from [DOCUMENT_TYPE] about [TOPIC]; [CHUNK]"

OUTPUT FORMAT (ONE SENTENCE ONLY):
`;
  }

  /**
   * Validate and sanitize context output
   */
  _validateContext(context) {
    if (!context || typeof context !== 'string') {
      return 'Context generation failed';
    }

    // Trim whitespace
    const trimmed = context.trim();

    // Ensure it's one sentence (ends with period, question mark, or exclamation)
    if (!/[.!?]$/.test(trimmed)) {
      return trimmed + '.';
    }

    return trimmed;
  }

  /**
   * Fallback context generation (no LLM)
   */
  _fallbackContext({ source, chunk }) {
    const sourceType = this._detectSourceType(source);
    const preview = chunk.substring(0, 100) + (chunk.length > 100 ? '...' : '');
    return `This is from ${sourceType} document; "${preview}"`;
  }

  /**
   * Detect document type from source
   */
  _detectSourceType(source) {
    if (!source) return 'unknown';

    const lower = source.toLowerCase();
    if (lower.includes('.pdf') || lower.includes('report')) return 'report';
    if (lower.includes('.md') || lower.includes('readme')) return 'documentation';
    if (lower.includes('.py') || lower.includes('.js') || lower.includes('.ts')) return 'code';
    if (lower.includes('meeting') || lower.includes('chat') || lower.includes('conversation')) return 'conversation';
    if (lower.includes('email') || lower.includes('mail')) return 'email';
    if (lower.includes('note') || lower.includes('journal')) return 'note';

    return 'document';
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
      cacheStats: this.getCacheStats(),
      model: this.getModel()
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    logger.info('Situationalizer cache cleared');
  }

  /**
   * Get situationalizer statistics
   */
  getStats() {
    return {
      model: this.getModel(),
      available: this.isAvailable(),
      cacheStats: this.getCacheStats(),
      tokenUsage: this.tokenUsage
    };
  }
}

// ==========================================
// Singleton Pattern
// ==========================================

let situationalizerInstance = null;

/**
 * Get or create GroqSituationalizer singleton
 * @param {Object} config - Configuration (optional)
 * @returns {GroqSituationalizer} Instance
 */
export function getSituationalizer(config = {}) {
  if (!situationalizerInstance) {
    situationalizerInstance = new GroqSituationalizer(config);
  }
  return situationalizerInstance;
}

// ==========================================
// Context Injection Pipeline
// ==========================================

/**
 * Contextual Pipeline - Integrates situationalizer with embedding
 */
export class ContextualPipeline {
  constructor(situationalizer = null) {
    this.situationalizer = situationalizer || getSituationalizer();
  }

  /**
   * Process a single chunk through the contextual pipeline
   * @param {Object} params
   * @param {string} params.chunk - Text chunk to contextualize
   * @param {string} params.fullDocument - Full document content
   * @param {string} params.source - Document source
   * @param {number} [params.chunkIndex=0] - Chunk position
   * @returns {Promise<Object>} Contextualized chunk with embedding
   */
  async processChunk({ chunk, fullDocument, source, chunkIndex = 0 }) {
    const startTime = Date.now();

    // Step 1: Generate situational context
    const context = await this.situationalizer.generateContext({
      fullDocument,
      chunk,
      source,
      chunkIndex
    });

    // Step 2: Inject context before original text
    const contextualizedText = `${context}\n\n${chunk}`;

    const latencyMs = Date.now() - startTime;

    logger.debug('Chunk processed through contextual pipeline', {
      source,
      chunkIndex,
      contextLength: context.length,
      contextualizedLength: contextualizedText.length,
      latencyMs
    });

    return {
      chunk,
      context,
      contextualizedText,
      chunkIndex,
      source,
      processedAt: new Date().toISOString(),
      latencyMs
    };
  }

  /**
   * Process multiple chunks through the contextual pipeline
   * @param {Array} chunks - Array of chunk objects
   * @param {string} fullDocument - Full document content
   * @param {string} source - Document source
   * @returns {Promise<Array>} Array of contextualized chunks
   */
  async processChunks(chunks, fullDocument, source) {
    const paramsArray = chunks.map((chunk, index) => ({
      chunk: chunk.text || chunk,
      fullDocument,
      source,
      chunkIndex: index
    }));

    return this.situationalizer.generateContextBatch(paramsArray).then(contexts => {
      return chunks.map((chunk, index) => ({
        chunk: chunk.text || chunk,
        context: contexts[index],
        contextualizedText: `${contexts[index]}\n\n${chunk.text || chunk}`,
        chunkIndex: index,
        source,
        processedAt: new Date().toISOString()
      }));
    });
  }

  /**
   * Get pipeline statistics
   */
  getStats() {
    return {
      situationalizer: this.situationalizer.getStats()
    };
  }
}

// ==========================================
// Export
// ==========================================

export default {
  GroqSituationalizer,
  ContextualPipeline,
  getSituationalizer,
  getContextualPipeline: () => new ContextualPipeline(),
  CONFIG
};

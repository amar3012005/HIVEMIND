/**
 * Groq Embedding Service
 * Ultra-low latency embeddings using Groq Cloud API
 * Fallback to Mistral AI if Groq is unavailable
 * 
 * Reference: https://console.groq.com/docs/embeddings
 */

import { getGroqClient, GROQ_MODELS, isReasoningModel } from '../../config/groq.js';

/**
 * Groq Embedding Service
 * Provides embedding generation with Groq Cloud API
 */
export class GroqEmbedService {
  constructor() {
    this.groqClient = getGroqClient();
    this.cache = new Map();
    this.provider = 'groq';
  }

  /**
   * Check if service is available
   * @returns {boolean}
   */
  isAvailable() {
    return this.groqClient.isAvailable();
  }

  /**
   * Get provider name
   * @returns {string}
   */
  getProvider() {
    return this.provider;
  }

  /**
   * Get model name
   * @returns {string}
   */
  getModel() {
    return this.groqClient.getConfig().embeddingModel;
  }

  /**
   * Get embedding dimension
   * @returns {number}
   */
  getDimension() {
    // nomic-embed-text produces 768-dimensional vectors
    return 768;
  }

  /**
   * Generate embedding for single text
   * @param {string} text - Text to embed
   * @param {string} cacheKey - Optional cache key
   * @returns {Promise<number[]>} Embedding vector
   */
  async embed(text, cacheKey = null) {
    if (!this.isAvailable()) {
      throw new Error('Groq embedding service not available');
    }

    // Use provided cache key or generate from text
    const lookupKey = cacheKey || `text:${this._hashText(text)}`;

    // Check cache first
    if (this.cache.has(lookupKey)) {
      return this.cache.get(lookupKey);
    }

    // Validate input length (Groq limit: 8192 tokens ≈ 32768 chars)
    if (text.length > 32768) {
      throw new Error('Text exceeds maximum length of 32768 characters');
    }

    const embedding = await this.groqClient.embed(text);

    // Cache result
    this.cache.set(lookupKey, embedding);

    return embedding;
  }

  /**
   * Generate embeddings for batch of texts
   * @param {string[]} texts - Array of texts to embed
   * @param {string[]} cacheKeys - Optional array of cache keys
   * @returns {Promise<number[][]>} Array of embedding vectors
   */
  async embedBatch(texts, cacheKeys = null) {
    if (!this.isAvailable()) {
      throw new Error('Groq embedding service not available');
    }

    if (texts.length === 0) {
      return [];
    }

    const results = new Array(texts.length);
    const textsToEmbed = [];
    const indicesToEmbed = [];

    // Check cache for each text
    texts.forEach((text, index) => {
      const lookupKey = cacheKeys?.[index] || `text:${this._hashText(text)}`;
      if (this.cache.has(lookupKey)) {
        results[index] = this.cache.get(lookupKey);
      } else {
        textsToEmbed.push(text);
        indicesToEmbed.push(index);
      }
    });

    // Process texts not in cache
    if (textsToEmbed.length > 0) {
      const embeddings = await this.groqClient.embedBatch(textsToEmbed);

      // Map results back to original indices
      embeddings.forEach((embedding, i) => {
        const originalIndex = indicesToEmbed[i];
        results[originalIndex] = embedding;

        // Cache result
        const lookupKey = cacheKeys?.[originalIndex] || `text:${this._hashText(texts[originalIndex])}`;
        this.cache.set(lookupKey, embedding);
      });
    }

    return results;
  }

  /**
   * Get usage statistics
   * @returns {Object} Usage data
   */
  getUsage() {
    return this.groqClient.getUsage();
  }

  /**
   * Reset usage statistics
   */
  resetUsage() {
    this.groqClient.resetUsage();
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    return {
      size: this.cache.size,
    };
  }

  /**
   * Simple hash function for cache keys
   * @param {string} text - Text to hash
   * @returns {string} Hash string
   */
  _hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getStats() {
    return {
      cacheSize: this.cache.size,
      provider: this.provider,
      model: this.getModel(),
      dimension: this.getDimension(),
    };
  }
}

/**
 * Singleton instance
 */
let groqEmbedService = null;

/**
 * Get or create Groq embedding service singleton
 * @returns {GroqEmbedService} Service instance
 */
export function getGroqEmbedService() {
  if (!groqEmbedService) {
    groqEmbedService = new GroqEmbedService();
  }
  return groqEmbedService;
}

/**
 * Check if text is suitable for Groq embeddings
 * @param {string} text - Text to check
 * @returns {boolean}
 */
export function isTextSuitableForGroq(text) {
  return text.length <= 32768 && text.length > 0;
}

/**
 * Prepare text for embedding with context
 * @param {Object} data - Data object with content
 * @param {string} data.content - Main content
 * @param {string[]} [data.tags=[]] - Tags to include
 * @param {string} [data.type=''] - Type prefix
 * @returns {string} Prepared text
 */
export function prepareTextForGroqEmbedding({ content, tags = [], type = '' }) {
  const parts = [];

  if (type) {
    parts.push(`[${type}]`);
  }

  parts.push(content);

  if (tags.length > 0) {
    parts.push(`[Tags: ${tags.join(', ')}]`);
  }

  return parts.join(' ');
}

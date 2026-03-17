/**
 * HIVE-MIND - Mistral AI Embedding Service
 *
 * Uses Mistral AI API (mistral-embed model) for 1024-dim embeddings.
 * BGE-M3 based model with multilingual support and 8192 token context.
 *
 * Also supports custom embedding endpoints (e.g., Hetzner SentenceTransformer)
 *
 * @module src/embeddings/mistral
 */

import fetch from 'node-fetch';
import https from 'https';

// Support custom embedding endpoint (e.g., Hetzner) or Mistral AI
const EMBEDDING_API_URL = process.env.EMBEDDING_MODEL_URL || 'https://api.mistral.ai/v1/embeddings';
const TARGET_EMBED_DIM = parseInt(process.env.EMBEDDING_DIMENSION || '1024', 10);

// Detect if using a custom local endpoint (SentenceTransformer format)
const IS_CUSTOM_ENDPOINT = EMBEDDING_API_URL.includes('/embed') && !EMBEDDING_API_URL.includes('mistral.ai');

// For custom internal endpoints, disable SSL certificate verification (self-signed certs)
const httpsAgent = IS_CUSTOM_ENDPOINT
  ? new https.Agent({ rejectUnauthorized: false })
  : null;

function normalizeVectorDimension(vector, targetDim = TARGET_EMBED_DIM) {
  const normalized = Array.isArray(vector) ? vector.slice(0, targetDim) : [];
  while (normalized.length < targetDim) {
    normalized.push(0);
  }
  return normalized;
}

export class MistralEmbedService {
  constructor(apiKey, model = 'mistral-embed', baseUrl = null) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl || EMBEDDING_API_URL;
    this.isCustomEndpoint = IS_CUSTOM_ENDPOINT || (baseUrl && baseUrl.includes('/embed') && !baseUrl.includes('mistral.ai'));
    this.dimension = TARGET_EMBED_DIM;
    this.cache = new Map();
  }

  /**
   * Generate embeddings for text
   * @param {string|string[]} input - Text or array of texts to embed
   * @returns {Promise<number[][]>} Array of embeddings
   */
  async embed(input) {
    const inputs = Array.isArray(input) ? input : [input];

    // Check cache
    const cacheKey = JSON.stringify(inputs);
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      // Custom endpoint (SentenceTransformer format) vs Mistral AI format
      const requestBody = this.isCustomEndpoint
        ? { sentences: inputs }
        : {
            model: this.model,
            input: inputs,
            encoding_format: 'float'
          };

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify(requestBody),
        ...(httpsAgent ? { agent: httpsAgent } : {})
      });

      if (!response.ok) {
        const error = await response.json();
        const errorMsg = error.message?.detail?.[0]?.msg ||
                         error.message?.detail ||
                         error.message ||
                         response.statusText;
        throw new Error(`Embedding API error: ${errorMsg}`);
      }

      const result = await response.json();

      // Extract embeddings based on response format
      let embeddings;
      if (this.isCustomEndpoint && result.embeddings) {
        // SentenceTransformer format: { embeddings: [[...], ...] }
        embeddings = result.embeddings.map(vec => normalizeVectorDimension(vec));
      } else if (result.data) {
        // Mistral AI format: { data: [{ index, embedding }, ...] }
        embeddings = result.data
          .sort((a, b) => a.index - b.index)
          .map(item => normalizeVectorDimension(item.embedding));
      } else {
        throw new Error('Unexpected embedding response format');
      }

      // Cache result
      this.cache.set(cacheKey, embeddings);

      return embeddings;
    } catch (error) {
      console.error('Embedding failed:', error.message);
      throw error;
    }
  }

  /**
   * Generate single embedding
   * @param {string} text - Text to embed
   * @returns {Promise<number[]>} Embedding vector
   */
  async embedOne(text) {
    const [embedding] = await this.embed(text);
    return embedding;
  }

  /**
   * Get embedding dimension
   * @returns {number} Dimension (1024 for mistral-embed)
   */
  getDimension() {
    return this.dimension;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache stats
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }

  /**
   * Test connection
   * @returns {Promise<boolean>} True if API is accessible
   */
  async testConnection() {
    try {
      console.log(`🔍 Testing embedding API connection...`);
      const embedding = await this.embedOne('Test connection');
      if (embedding.length === this.dimension) {
        console.log('✅ Embedding API connection successful');
        console.log(`   Dimension: ${this.dimension}, Model: ${this.model}, URL: ${this.baseUrl}`);
        return true;
      } else {
        console.error(`❌ Embedding API returned unexpected dimension: ${embedding.length} (expected ${this.dimension})`);
        return false;
      }
    } catch (error) {
      console.error('❌ Embedding connection test failed:', error.message);
      return false;
    }
  }
}

// Factory function for easy initialization
let instance = null;

export function getMistralEmbedService() {
  if (!instance) {
    const apiKey = process.env.MISTRAL_API_KEY || process.env.EMBEDDING_API_KEY;
    const model = process.env.MISTRAL_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL_NAME || 'mistral-embed';
    const baseUrl = process.env.EMBEDDING_MODEL_URL;

    // Allow no API key for local/embedded endpoints
    if (!apiKey && (!baseUrl || baseUrl.startsWith('http'))) {
      console.warn('⚠️  Neither MISTRAL_API_KEY nor EMBEDDING_API_KEY configured. Embeddings may fail.');
    }

    instance = new MistralEmbedService(apiKey, model, baseUrl);
  }

  return instance;
}

export default MistralEmbedService;

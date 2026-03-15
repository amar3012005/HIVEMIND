/**
 * HIVE-MIND - Mistral AI Embedding Service
 * 
 * Uses Mistral AI API (mistral-embed model) for 1024-dim embeddings.
 * BGE-M3 based model with multilingual support and 8192 token context.
 * 
 * @module src/embeddings/mistral
 */

import fetch from 'node-fetch';

const MISTRAL_API_URL = 'https://api.mistral.ai/v1/embeddings';
const TARGET_EMBED_DIM = 1536;

function normalizeVectorDimension(vector, targetDim = TARGET_EMBED_DIM) {
  const normalized = Array.isArray(vector) ? vector.slice(0, targetDim) : [];
  while (normalized.length < targetDim) {
    normalized.push(0);
  }
  return normalized;
}

export class MistralEmbedService {
  constructor(apiKey, model = 'mistral-embed') {
    if (!apiKey) {
      throw new Error('Mistral API key is required');
    }
    
    this.apiKey = apiKey;
    this.model = model;
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
      const response = await fetch(MISTRAL_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          input: inputs,
          encoding_format: 'float'
        })
      });

      if (!response.ok) {
        const error = await response.json();
        // Handle Mistral's nested error structure
        const errorMsg = error.message?.detail?.[0]?.msg || 
                         error.message?.detail || 
                         error.message || 
                         response.statusText;
        throw new Error(`Mistral API error: ${errorMsg}`);
      }

      const result = await response.json();
      
      // Extract embeddings from response
      const embeddings = result.data
        .sort((a, b) => a.index - b.index)
        .map(item => normalizeVectorDimension(item.embedding));

      // Cache result
      this.cache.set(cacheKey, embeddings);

      return embeddings;
    } catch (error) {
      console.error('Mistral embedding failed:', error.message);
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
      console.log('🔍 Testing Mistral AI API connection...');
      const embedding = await this.embedOne('Test connection');
      if (embedding.length === this.dimension) {
        console.log('✅ Mistral AI API connection successful');
        console.log(`   Dimension: ${this.dimension}, Model: ${this.model}`);
        return true;
      } else {
        console.error('❌ Mistral API returned unexpected embedding dimension');
        return false;
      }
    } catch (error) {
      console.error('❌ Mistral connection test failed:', error.message);
      return false;
    }
  }
}

// Factory function for easy initialization
let instance = null;

export function getMistralEmbedService() {
  if (!instance) {
    const apiKey = process.env.MISTRAL_API_KEY;
    const model = process.env.MISTRAL_EMBEDDING_MODEL || 'mistral-embed';
    
    if (!apiKey) {
      console.warn('⚠️  MISTRAL_API_KEY not configured. Embeddings will fail.');
      return null;
    }
    
    instance = new MistralEmbedService(apiKey, model);
  }
  
  return instance;
}

export default MistralEmbedService;

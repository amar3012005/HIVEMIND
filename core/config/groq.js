/**
 * Groq Cloud API Configuration
 * Ultra-low latency embeddings and inference for HIVE-MIND
 * 
 * Reference: https://console.groq.com/docs
 */

/**
 * Groq Configuration
 * @typedef {Object} GroqConfig
 * @property {string} apiKey - Groq API key (required)
 * @property {string} embeddingModel - Model for embeddings (default: nomic-embed-text)
 * @property {string} inferenceModel - Model for inference (default: llama-3-3-70b-versatile)
 * @property {number} timeout - Request timeout in ms (default: 30000)
 * @property {number} maxRetries - Maximum retry attempts (default: 3)
 */

/**
 * Available Groq Models
 * Reference: https://console.groq.com/docs/models
 */
export const GROQ_MODELS = {
  embedding: {
    nomicEmbedText: 'nomic-embed-text',
    llama32: 'llama3-2-1b',
    llama32_3b: 'llama3-2-3b',
    llama32_11b: 'llama3-2-11b',
    llama32_90b: 'llama3-2-90b',
  },
  inference: {
    llama33_70b: 'llama-3-3-70b-versatile',
    llama3_70b: 'llama3-70b-8192',
    llama3_8b: 'llama3-8b-8192',
    gptOss20b: 'gpt-oss-20b',
    gptOss5b: 'gpt-oss-5b',
    llama31_405b: 'llama3-405b-reasoning',
    llama31_70b: 'llama3-70b-8192',
    llama31_8b: 'llama3-8b-8192',
    mixtral_8x7b: 'mixtral-8x7b-32768',
    gemma2_9b: 'gemma2-9b-it',
    gemma_7b: 'gemma-7b-it',
  },
  reasoning: {
    llama31_405b: 'llama3-405b-reasoning',
    gptOss20b: 'gpt-oss-20b',
    gptOss5b: 'gpt-oss-5b',
  }
};

/**
 * Default configuration
 */
export const DEFAULT_CONFIG = {
  apiKey: process.env.GROQ_API_KEY || 'your-groq-api-key-here',
  embeddingModel: process.env.GROQ_EMBEDDING_MODEL || 'nomic-embed-text',
  inferenceModel: process.env.GROQ_INFERENCE_MODEL || 'llama-3-3-70b-versatile',
  timeout: parseInt(process.env.GROQ_TIMEOUT || '30000', 10),
  maxRetries: parseInt(process.env.GROQ_MAX_RETRIES || '3', 10),
};

/**
 * Groq Client Class
 * Provides unified access to Groq embeddings and inference
 */
export class GroqClient {
  /**
   * @param {GroqConfig} config - Configuration options
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Validate API key
    if (!this.config.apiKey || this.config.apiKey === 'your-groq-api-key-here') {
      console.warn('⚠️  Groq API key not configured. Embeddings and inference will fail.');
    }

    // Usage tracking
    this.usage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      requests: 0,
    };

    // Cache for embeddings
    this.embeddingCache = new Map();
  }

  /**
   * Check if Groq is available (has valid API key)
   * @returns {boolean}
   */
  isAvailable() {
    return (
      this.config.apiKey &&
      this.config.apiKey !== 'your-groq-api-key-here' &&
      this.config.apiKey.length > 10
    );
  }

  /**
   * Get current configuration
   * @returns {GroqConfig}
   */
  getConfig() {
    return { ...this.config };
  }

  /**
   * Get usage statistics
   * @returns {Object} Usage statistics
   */
  getUsage() {
    return { ...this.usage };
  }

  /**
   * Reset usage statistics
   */
  resetUsage() {
    this.usage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      requests: 0,
    };
  }

  /**
   * Generate embedding for single text
   * @param {string} text - Text to embed
   * @param {string} model - Model to use (optional, uses default)
   * @returns {Promise<number[]>} Embedding vector
   */
  async embed(text, model = null) {
    if (!this.isAvailable()) {
      throw new Error('Groq API key not configured');
    }

    // Check cache
    const cacheKey = this._hashText(text);
    if (this.embeddingCache.has(cacheKey)) {
      this.usage.requests++;
      return this.embeddingCache.get(cacheKey);
    }

    const startTime = Date.now();
    const response = await this._request('/embeddings', {
      model: model || this.config.embeddingModel,
      input: text,
    });

    const embedding = response.data[0].embedding;
    
    // Cache result
    this.embeddingCache.set(cacheKey, embedding);

    // Update usage
    this._updateUsage(response.usage);

    return embedding;
  }

  /**
   * Generate embeddings for batch of texts
   * @param {string[]} texts - Array of texts to embed
   * @param {string} model - Model to use (optional, uses default)
   * @returns {Promise<number[][]>} Array of embedding vectors
   */
  async embedBatch(texts, model = null) {
    if (!this.isAvailable()) {
      throw new Error('Groq API key not configured');
    }

    const results = [];
    const textsToEmbed = [];
    const cachedIndices = [];

    // Check cache for each text
    texts.forEach((text, index) => {
      const cacheKey = this._hashText(text);
      if (this.embeddingCache.has(cacheKey)) {
        cachedIndices.push(index);
        results[index] = this.embeddingCache.get(cacheKey);
      } else {
        textsToEmbed.push({ text, index });
      }
    });

    if (textsToEmbed.length > 0) {
      const response = await this._request('/embeddings', {
        model: model || this.config.embeddingModel,
        input: textsToEmbed.map(t => t.text),
      });

      // Map results back to original indices
      response.data.forEach((item, i) => {
        const originalIndex = textsToEmbed[i].index;
        results[originalIndex] = item.embedding;
        this.embeddingCache.set(this._hashText(texts[originalIndex]), item.embedding);
      });

      this._updateUsage(response.usage);
    }

    this.usage.requests++;
    return results;
  }

  /**
   * Generate completion/inference
   * @param {string} prompt - Input prompt
   * @param {Object} options - Generation options
   * @returns {Promise<string>} Generated text
   */
  async generate(prompt, options = {}) {
    if (!this.isAvailable()) {
      throw new Error('Groq API key not configured');
    }

    const response = await this._request('/chat/completions', {
      model: options.model || this.config.inferenceModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 1024,
      stream: false,
    });

    this._updateUsage(response.usage);

    return response.choices[0].message.content;
  }

  /**
   * Generate with streaming
   * @param {string} prompt - Input prompt
   * @param {Object} options - Generation options
   * @returns {AsyncGenerator<string>} Stream of text chunks
   */
  async *generateStream(prompt, options = {}) {
    if (!this.isAvailable()) {
      throw new Error('Groq API key not configured');
    }

    const response = await this._request('/chat/completions', {
      model: options.model || this.config.inferenceModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 1024,
      stream: true,
    });

    let fullContent = '';
    for await (const chunk of response) {
      const content = chunk.choices[0]?.delta?.content || '';
      fullContent += content;
      yield content;
    }

    // Calculate usage from final chunk if available
    if (response.usage) {
      this._updateUsage(response.usage);
    } else {
      // Estimate tokens for streaming
      this.usage.promptTokens += prompt.length / 4; // Rough estimate
      this.usage.completionTokens += fullContent.length / 4;
      this.usage.totalTokens = this.usage.promptTokens + this.usage.completionTokens;
    }
    this.usage.requests++;
  }

  /**
   * Generate with reasoning (for reasoning models)
   * @param {string} prompt - Input prompt
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Object with content and reasoning
   */
  async generateWithReasoning(prompt, options = {}) {
    if (!this.isAvailable()) {
      throw new Error('Groq API key not configured');
    }

    const response = await this._request('/chat/completions', {
      model: options.model || this.config.inferenceModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature ?? 0.7,
      max_completion_tokens: options.maxTokens ?? 2048,
      include_reasoning: true,
    });

    const message = response.choices[0].message;
    this._updateUsage(response.usage);

    return {
      content: message.content || '',
      reasoning: message.reasoning || '',
    };
  }

  /**
   * Make API request to Groq
   * @param {string} endpoint - API endpoint
   * @param {Object} body - Request body
   * @returns {Promise<any>} Response data
   */
  async _request(endpoint, body) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        const response = await fetch(`https://api.groq.com/openai/v1${endpoint}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Groq API error: ${response.status} - ${error}`);
        }

        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt < this.config.maxRetries) {
          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      }
    }

    throw lastError;
  }

  /**
   * Update usage statistics
   * @param {Object} usage - Usage data from API
   */
  _updateUsage(usage) {
    this.usage.promptTokens += usage.prompt_tokens || 0;
    this.usage.completionTokens += usage.completion_tokens || 0;
    this.usage.totalTokens += usage.total_tokens || 0;
    this.usage.cachedTokens += usage.cached_tokens || 0;
    this.usage.requests++;
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
   * Clear embedding cache
   */
  clearCache() {
    this.embeddingCache.clear();
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    return {
      size: this.embeddingCache.size,
    };
  }
}

/**
 * Singleton instance
 */
let groqClientInstance = null;

/**
 * Get or create Groq client singleton
 * @param {GroqConfig} config - Configuration (optional)
 * @returns {GroqClient} Client instance
 */
export function getGroqClient(config = {}) {
  if (!groqClientInstance) {
    groqClientInstance = new GroqClient(config);
  }
  return groqClientInstance;
}

/**
 * Check if a model is a reasoning model
 * @param {string} modelName - Model name
 * @returns {boolean}
 */
export function isReasoningModel(modelName) {
  return (
    modelName?.includes('405b') ||
    modelName?.includes('gpt-oss')
  );
}

/**
 * Get model type
 * @param {string} modelName - Model name
 * @returns {'embedding'|'inference'|'reasoning'|'unknown'}
 */
export function getModelType(modelName) {
  if (!modelName) return 'unknown';

  const embeddingModels = Object.values(GROQ_MODELS.embedding);
  const reasoningModels = Object.values(GROQ_MODELS.reasoning);

  if (embeddingModels.includes(modelName)) return 'embedding';
  if (reasoningModels.includes(modelName)) return 'reasoning';
  return 'inference';
}

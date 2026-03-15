/**
 * HIVE-MIND Situationalizer
 * Pre-Embedding Context Generator using Groq API
 * 
 * Converts raw text into context-rich memories with situational awareness.
 * Example: "This is from the Q3 2025 Financial Report; Revenue grew by 3%"
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Groq Situationalizer - Uses Groq API to generate context for memories
 */
export class GroqSituationalizer {
  constructor(apiKey, model = 'llama-3.3-70b-versatile') {
    this.apiKey = apiKey || process.env.GROQ_API_KEY;
    this.model = model;
    this.cache = new Map();
  }

  /**
   * Generate situational context for a piece of text
   * @param {string} content - Raw text content
   * @param {object} context - Source context (project, tags, date, etc.)
   * @returns {Promise<string>} Situationalized text
   */
  async situationalize(content, context = {}) {
    const cacheKey = this._getCacheKey(content, context);
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const source = this._buildSourceString(context);

    const prompt = `You are a situationalizer. Convert raw text into context-rich memories.

Input: ${content}
Source: ${source}

Output: A one-sentence context that includes the source information.
Format: "This is from [SOURCE]; [ORIGINAL_TEXT]"

Rules:
1. Keep the original text intact
2. Add source context at the beginning
3. Make it one concise sentence
4. Do not add explanations`;

    try {
      if (!this.apiKey) {
        throw new Error('Groq API key not configured');
      }

      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'user', content: prompt }
          ],
          max_tokens: 150
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Groq API error: ${error.message || response.statusText}`);
      }

      const result = await response.json();
      const text = result.choices?.[0]?.message?.content || '';

      // Cache the result
      this.cache.set(cacheKey, text);

      return text;
    } catch (error) {
      console.error('Situationalization failed:', error);
      // Fallback: return original content with basic context
      return this._buildFallbackContext(content, context);
    }
  }

  /**
   * Build source context string from metadata
   */
  _buildSourceString(context) {
    const parts = [];
    if (context.project) parts.push(`Project: ${context.project}`);
    if (context.tags && context.tags.length > 0) parts.push(`Tags: ${context.tags.join(', ')}`);
    if (context.source) parts.push(`Source: ${context.source}`);
    if (context.document_date) parts.push(`Date: ${context.document_date}`);
    if (context.event_dates && context.event_dates.length > 0) {
      parts.push(`Events: ${context.event_dates.join(', ')}`);
    }
    return parts.join(' | ');
  }

  /**
   * Fallback context when API fails
   */
  _buildFallbackContext(content, context) {
    const source = this._buildSourceString(context);
    if (source) {
      return `This is from ${source}; ${content}`;
    }
    return content;
  }

  /**
   * Generate cache key
   */
  _getCacheKey(content, context) {
    return `${content.substring(0, 100)}|${JSON.stringify(context)}`;
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
}

/**
 * Batch situationalizer for multiple texts
 */
export class BatchSituationalizer {
  constructor(apiKey, batchSize = 10) {
    this.situationalizer = new GroqSituationalizer(apiKey);
    this.batchSize = batchSize;
  }

  /**
   * Process multiple texts in batches
   */
  async situationalizeBatch(items) {
    const results = [];

    for (let i = 0; i < items.length; i += this.batchSize) {
      const batch = items.slice(i, i + this.batchSize);

      // Process batch in parallel
      const batchResults = await Promise.all(
        batch.map(item => this.situationalizer.situationalize(item.content, item.context))
      );

      results.push(...batchResults);
    }

    return results;
  }
}

// Default exports for engine integration
const defaultApiKey = process.env.GROQ_API_KEY || 'your-groq-api-key-here';
const defaultModel = process.env.GROQ_INFERENCE_MODEL || 'llama-3.3-70b-versatile';

export function getSituationalizer() {
  return new GroqSituationalizer(defaultApiKey, defaultModel);
}

export class ContextualPipeline {
  constructor(situationalizer) {
    this.situationalizer = situationalizer;
  }

  /**
   * Process a single chunk through the contextual pipeline
   * @param {Object} params
   * @param {string} params.chunk - Chunk text content
   * @param {string} params.fullDocument - Full document content for context
   * @param {string} params.source - Document source
   * @param {number} params.chunkIndex - Index of chunk in document
   * @returns {Promise<Object>} Processed chunk with contextualized text
   */
  async processChunk({ chunk, fullDocument, source, chunkIndex }) {
    if (!this.situationalizer) {
      return {
        chunkIndex,
        originalText: chunk,
        contextualizedText: chunk,
        source,
        contextGeneratedAt: null
      };
    }

    const context = {
      source,
      chunkIndex,
      documentLength: fullDocument?.length || 0
    };

    const contextualizedText = await this.situationalizer.situationalize(chunk, context);

    return {
      chunkIndex,
      originalText: chunk,
      contextualizedText,
      source,
      contextGeneratedAt: new Date().toISOString()
    };
  }

  /**
   * Process full content through the pipeline
   * @param {string} content - Content to process
   * @param {object} context - Context metadata
   * @returns {Promise<string>} Processed content
   */
  async process(content, context = {}) {
    if (!this.situationalizer) return content;
    return await this.situationalizer.situationalize(content, context);
  }
}

export default GroqSituationalizer;

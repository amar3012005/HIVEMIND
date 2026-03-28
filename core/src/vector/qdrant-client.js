/**
 * HIVE-MIND - Qdrant Vector Database Client
 * 
 * Handles vector storage and retrieval from Qdrant.
 * Integrates with Mistral AI for automatic embeddings.
 * 
 * @module src/vector/qdrant-client
 */

import fetch from 'node-fetch';
import { getMistralEmbedService } from '../embeddings/mistral.js';
import { getQdrantCollections } from './collections.js';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:9200';
const API_KEY = process.env.QDRANT_API_KEY || 'dev_api_key_hivemind_2026';
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || 'BUNDB AGENT';
const DEFAULT_SCORE_THRESHOLD = parseFloat(process.env.HIVEMIND_VECTOR_SCORE_THRESHOLD || '0.15');

const headers = {
  'Content-Type': 'application/json',
  'api-key': API_KEY
};

function resolveCollectionName(collectionName) {
  return collectionName || COLLECTION_NAME;
}

export class QdrantClient {
  constructor() {
    this.collectionName = COLLECTION_NAME;
    this.embedService = getMistralEmbedService();
    this.dimension = parseInt(process.env.EMBEDDING_DIMENSION || '1024', 10);
    this.connected = null; // Cache connection state
    this.collectionReady = null;
  }

  async ensureCollection(collectionName = this.collectionName) {
    if (this.collectionReady === collectionName) {
      return true;
    }

    try {
      const response = await fetch(`${QDRANT_URL}/collections/${resolveCollectionName(collectionName)}`, { headers });
      if (response.ok) {
        this.collectionReady = collectionName;
        return true;
      }

      if (response.status !== 404) {
        return false;
      }

      const collections = getQdrantCollections({
        url: QDRANT_URL,
        apiKey: API_KEY
      });

      await collections.createMemoriesCollection();
      await collections.ensureMemoriesCollectionIndexes(resolveCollectionName(collectionName));
      this.collectionReady = collectionName;
      return true;
    } catch (error) {
      console.error('Failed to ensure Qdrant collection:', error.message);
      return false;
    }
  }

  /**
   * Check if Qdrant is available
   * @returns {Promise<boolean>} Connection status
   */
  async isConnected() {
    if (this.connected !== null) {
      return this.connected;
    }
    this.connected = await this.testConnection();
    return this.connected;
  }

  /**
   * Generate embedding for text
   * @param {string} text - Text to embed
   * @returns {Promise<number[]>} Configured embedding vector
   */
  async generateEmbedding(text) {
    if (!this.embedService) {
      console.warn('⚠️  Embedding service not available');
      return null;
    }
    
    try {
      return await this.embedService.embedOne(text);
    } catch (error) {
      console.error('Embedding generation failed:', error.message);
      return null;
    }
  }

  /**
   * Store memory with vector embedding
   * @param {object} memory - Memory object with content and metadata
   * @returns {Promise<string>} Memory ID
   */
  async storeMemory(memory, options = {}) {
    // Check connection first
    const connected = await this.isConnected();
    if (!connected) {
      console.warn('⚠️  Qdrant unavailable, storing in-memory only');
      return memory.id;
    }

    const collectionName = resolveCollectionName(options.collectionName);
    const collectionReady = await this.ensureCollection(collectionName);
    if (!collectionReady) {
      console.warn('⚠️  Qdrant collection unavailable, storing in-memory only');
      return memory.id;
    }

    // Fact-augmented key expansion: embed enriched key, store raw content in payload
    let embeddingInput = memory.content;
    try {
      const { extractFacts, buildAugmentedKey } = await import('../memory/fact-extractor.js');
      const facts = await extractFacts(memory.content || '', { useLLM: false });
      embeddingInput = buildAugmentedKey(memory.content || '', facts);
    } catch (augErr) {
      // Fallback to raw content if fact extraction fails
      console.warn('[qdrant] Fact extraction failed, using raw content:', augErr.message);
    }
    const embedding = await this.generateEmbedding(embeddingInput);

    if (!embedding) {
      console.warn('⚠️  Storing memory without embedding');
    }

    const point = {
      id: memory.id,
      vector: embedding || this._generatePlaceholderVector(),
      payload: {
        user_id: memory.user_id,
        org_id: memory.org_id,
        project: memory.project,
        memory_type: memory.memory_type,
        tags: memory.tags || [],
        content: memory.content,
        is_latest: memory.is_latest ?? true,
        created_at: memory.created_at || new Date().toISOString(),
        source: memory.source || memory.source_metadata?.source_platform || null,
        source_platform: memory.source_metadata?.source_platform || memory.source || null,
        document_date: memory.document_date,
        content_hash: memory.content_hash,
        relationship_type: memory.relationship_type,
        importance_score: memory.importance_score,
        strength: memory.strength,
        recall_count: memory.recall_count,
        visibility: memory.visibility,
        embedding_version: memory.embedding_version,
        temporal_status: memory.temporal_status,
        decay_factor: memory.decay_factor,
        metadata: memory.metadata || {}
      }
    };

    try {
      const response = await fetch(
        `${QDRANT_URL}/collections/${collectionName}/points`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            points: [point],
            wait: true
          })
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Qdrant upsert failed: ${JSON.stringify(error)}`);
      }

      return memory.id;
    } catch (error) {
      console.error('Failed to store memory in Qdrant:', error.message);
      // Don't throw - allow in-memory storage to succeed
      return memory.id;
    }
  }

  /**
   * Search memories by vector similarity
   * @param {object} options - Search options
   * @param {string} options.query - Query text (will be embedded)
   * @param {number[]} options.vector - Pre-computed vector (optional)
   * @param {object} options.filter - Qdrant filter (optional)
   * @param {number} options.limit - Max results (default: 10)
   * @param {number} options.score_threshold - Minimum similarity score
   * @returns {Promise<Array>} Search results
   */
  async searchMemories({ query, vector, filter, limit = 10, score_threshold = DEFAULT_SCORE_THRESHOLD, collectionName }) {
    // Check connection first
    const connected = await this.isConnected();
    if (!connected) {
      console.warn('⚠️  Qdrant unavailable, search returning empty results');
      return [];
    }

    const resolvedCollection = resolveCollectionName(collectionName);
    const collectionReady = await this.ensureCollection(resolvedCollection);
    if (!collectionReady) {
      console.warn('⚠️  Qdrant collection unavailable, search returning empty results');
      return [];
    }

    // Generate query embedding if not provided
    let searchVector = vector;
    if (!searchVector && query) {
      searchVector = await this.generateEmbedding(query);
    }

    if (!searchVector) {
      console.warn('⚠️  No vector available for search');
      return [];
    }

    const effectiveScoreThreshold = this.embedService?.provider === 'local-fallback'
      ? 0
      : score_threshold;

    const searchRequest = {
      vector: searchVector,
      limit,
      score_threshold: effectiveScoreThreshold,
      with_payload: true,
      with_vector: false
    };

    // Add user/org filter for multi-tenancy
    if (filter) {
      searchRequest.filter = filter;
    }

    try {
      const response = await fetch(
        `${QDRANT_URL}/collections/${resolvedCollection}/points/search`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(searchRequest)
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Qdrant search failed: ${JSON.stringify(error)}`);
      }

      const result = await response.json();
      return result.result || [];
    } catch (error) {
      console.error('Failed to search memories:', error.message);
      return [];
    }
  }

  /**
   * Search with hybrid approach (vector + keyword filters)
   * @param {string} query - Query text
   * @param {object} filters - Keyword filters
   * @returns {Promise<Array>} Search results
   */
  async hybridSearch(query, filters = {}) {
    const mustFilters = [];

    // Add user/org filters for isolation
    if (filters.user_id) {
      mustFilters.push({
        key: 'user_id',
        match: { value: filters.user_id }
      });
    }

    if (filters.org_id) {
      mustFilters.push({
        key: 'org_id',
        match: { value: filters.org_id }
      });
    }

    // Add project filter
    if (filters.project) {
      mustFilters.push({
        key: 'project',
        match: { value: filters.project }
      });
    }

    // Add tags filter
    if (filters.tags && filters.tags.length > 0) {
      mustFilters.push({
        key: 'tags',
        match: { any: filters.tags }
      });
    }

    // Add is_latest filter
    if (filters.is_latest !== undefined) {
      mustFilters.push({
        key: 'is_latest',
        match: { value: filters.is_latest }
      });
    }

    const filter = mustFilters.length > 0 ? { must: mustFilters } : undefined;

    return await this.searchMemories({
      query,
      filter,
      limit: filters.limit || 10,
      score_threshold: filters.score_threshold || 0.5,
      collectionName: filters.collectionName
    });
  }

  /**
   * Get memory by ID
   * @param {string} memoryId - Memory ID
   * @returns {Promise<object|null>} Memory or null
   */
  async getMemory(memoryId) {
    // Check connection first
    const connected = await this.isConnected();
    if (!connected) {
      return null;
    }

    try {
      const response = await fetch(
        `${QDRANT_URL}/collections/${this.collectionName}/points/${memoryId}`,
        {
          headers,
          body: JSON.stringify({ with_payload: true, with_vector: false })
        }
      );

      if (!response.ok) {
        return null;
      }

      const result = await response.json();
      return result.result || null;
    } catch (error) {
      console.error('Failed to get memory:', error.message);
      return null;
    }
  }

  /**
   * Delete memory by ID
   * @param {string} memoryId - Memory ID
   * @returns {Promise<boolean>} Success
   */
  async deleteMemory(memoryId) {
    // Check connection first
    const connected = await this.isConnected();
    if (!connected) {
      console.warn('⚠️  Qdrant unavailable, delete skipped');
      return false;
    }

    try {
      const response = await fetch(
        `${QDRANT_URL}/collections/${this.collectionName}/points/delete`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            points: [memoryId],
            wait: true
          })
        }
      );

      return response.ok;
    } catch (error) {
      console.error('Failed to delete memory:', error.message);
      return false;
    }
  }

  /**
   * Batch store memories
   * @param {Array} memories - Array of memory objects
   * @returns {Promise<Array>} Memory IDs
   */
  async storeMemoriesBatch(memories) {
    // Check connection first
    const connected = await this.isConnected();
    if (!connected) {
      console.warn('⚠️  Qdrant unavailable, batch store skipped');
      return memories.map(m => m.id);
    }

    const points = [];

    for (const memory of memories) {
      const embedding = await this.generateEmbedding(memory.content);

      points.push({
        id: memory.id,
        vector: embedding || this._generatePlaceholderVector(),
        payload: {
          user_id: memory.user_id,
          org_id: memory.org_id,
          project: memory.project,
          memory_type: memory.memory_type,
          tags: memory.tags || [],
          content: memory.content,
          is_latest: memory.is_latest ?? true,
          created_at: memory.created_at || new Date().toISOString(),
          source_platform: memory.source_metadata?.source_platform || memory.source || null,
          document_date: memory.document_date,
          importance_score: memory.importance_score,
          strength: memory.strength,
          recall_count: memory.recall_count,
          visibility: memory.visibility,
          embedding_version: memory.embedding_version,
          temporal_status: memory.temporal_status,
          ...memory
        }
      });
    }

    try {
      const response = await fetch(
        `${QDRANT_URL}/collections/${this.collectionName}/points`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            points,
            wait: true
          })
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Batch upsert failed: ${JSON.stringify(error)}`);
      }

      return memories.map(m => m.id);
    } catch (error) {
      console.error('Failed to batch store memories:', error.message);
      // Return IDs anyway - allow in-memory storage to succeed
      return memories.map(m => m.id);
    }
  }

  /**
   * Get collection stats
   * @returns {Promise<object>} Collection statistics
   */
  async getStats() {
    // Check connection first
    const connected = await this.isConnected();
    if (!connected) {
      return {
        status: 'unavailable',
        points_count: 0,
        vectors_count: 0,
        indexed_vectors_count: 0,
        vector_size: this.dimension,
        distance: 'Cosine',
        warning: 'Qdrant is not available'
      };
    }

    try {
      const response = await fetch(
        `${QDRANT_URL}/collections/${this.collectionName}`,
        { headers }
      );

      if (!response.ok) {
        return null;
      }

      const result = await response.json();
      const data = result.result;

      return {
        status: data.status,
        points_count: data.points_count || 0,
        vectors_count: data.vectors_count || 0,
        indexed_vectors_count: data.indexed_vectors_count || 0,
        vector_size: data.config?.params?.vectors?.size,
        distance: data.config?.params?.vectors?.distance
      };
    } catch (error) {
      console.error('Failed to get stats:', error.message);
      return {
        status: 'error',
        points_count: 0,
        vectors_count: 0,
        indexed_vectors_count: 0,
        vector_size: this.dimension,
        distance: 'Cosine',
        error: error.message
      };
    }
  }

  /**
   * Generate placeholder vector (fallback)
   * @returns {number[]} Random placeholder vector matching configured embedding dimension
   * @private
   */
  _generatePlaceholderVector() {
    return new Array(this.dimension).fill(0).map(() => Math.random() * 2 - 1);
  }

  /**
   * Test connection
   * @returns {Promise<boolean>} True if Qdrant is accessible
   */
  async testConnection() {
    try {
      console.log('🔍 Testing Qdrant connection...');
      const response = await fetch(`${QDRANT_URL}/`, { headers });
      if (response.ok) {
        console.log('✅ Qdrant connection successful');
        console.log(`   URL: ${QDRANT_URL}, Collection: ${this.collectionName}`);
        return true;
      } else {
        console.error('❌ Qdrant responded with status:', response.status);
        return false;
      }
    } catch (error) {
      console.error('❌ Qdrant connection test failed:', error.message);
      return false;
    }
  }

  /**
   * Get the configured collection name
   * @returns {string} Current collection name
   */
  getCollectionName() {
    return this.collectionName;
  }
}

// Singleton instance
let instance = null;

export function getQdrantClient() {
  if (!instance) {
    instance = new QdrantClient();
  }
  return instance;
}

export default QdrantClient;

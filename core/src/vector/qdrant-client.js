/**
 * HIVE-MIND - Qdrant Vector Database Client
 * 
 * Handles vector storage and retrieval from Qdrant.
 * Integrates with Mistral AI for automatic embeddings.
 * 
 * @module src/vector/qdrant-client
 */

import fetch from 'node-fetch';
import { getEmbedService } from '../embeddings/factory.js';
import { getQdrantCollections } from './collections.js';
import { resolveCollectionForOrg, PER_TENANT } from './container-router.js';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:9200';
const API_KEY = process.env.QDRANT_API_KEY || 'dev_api_key_hivemind_2026';
const COLLECTION_NAME = 'HIVEMIND_PERSONAL';
const DEFAULT_SCORE_THRESHOLD = parseFloat(process.env.HIVEMIND_VECTOR_SCORE_THRESHOLD || '0.15');
// P4: search-time HNSW ef — THE recall/latency dial at scale (OpenSearch
// benchmark: recall@1 0.56→0.97 across ef 10→640). Without an explicit
// params.hnsw_ef, Qdrant uses an untuned internal default with no control.
// 128 explores ~1% of the HNSW graph at 10M vectors → recall@150 collapses with
// int8 quant. 200 recovers buried hits in the wide candidate pool for a few ms
// more. Tune via QDRANT_HNSW_EF without redeploy; raise toward 256–400 at very
// large scale.
const EF_SEARCH_DEFAULT = Number(process.env.QDRANT_HNSW_EF || 200);
// int8 quant rescore — re-rank the quantized ANN candidates against full-
// precision vectors at search time (oversample, then rescore). Kills the
// quantization tail-rank noise. Default ON; QDRANT_QUANT_RESCORE=false disables.
const QUANT_RESCORE = process.env.QDRANT_QUANT_RESCORE !== 'false';
const QUANT_OVERSAMPLING = Number(process.env.QDRANT_QUANT_OVERSAMPLING || 2.0);

const headers = {
  'Content-Type': 'application/json',
  'api-key': API_KEY
};

function resolveCollectionName(collectionName) {
  return collectionName || COLLECTION_NAME;
}

// Pull a payload value out of a Qdrant filter's `must` clause (used to derive
// the org for routing when the caller didn't pass an explicit collectionName).
function filterMatchValue(filter, key) {
  const must = filter?.must;
  if (!Array.isArray(must)) return null;
  const clause = must.find((c) => c?.key === key);
  return clause?.match?.value ?? null;
}

// Central tenant routing. When QDRANT_PER_TENANT is off this returns the legacy
// collection (unchanged behavior). When on, routes by org PLAN (looked up +
// cached): enterprise org → org_<id>, free/personal/no-org → HIVEMIND_PERSONAL.
// Derives org from the data the client already receives (memory.org_id /
// filter org_id) so no call site needs changing.
async function routeCollection({ explicit, orgId } = {}) {
  // Per-tenant routing MUST win over a legacy default collection name. Many save
  // sites pass collectionName = (QDRANT_COLLECTION || 'BUNDB AGENT') explicitly;
  // under the old `if (explicit) return explicit` that silently wrote vectors to
  // the legacy 'BUNDB AGENT' store while recall auto-routed reads to org_<id>.
  // Net effect: every memory saved through those paths was invisible to vector
  // recall → keyword-only fallback → "recall/KB not working". When per-tenant is
  // on and the org is known, ignore a legacy/default explicit name and route to
  // the org collection; honor only NON-legacy explicit names (e.g.
  // evidence-retrieval's own collection, an explicit org_<id>/HIVEMIND_PERSONAL).
  if (PER_TENANT && orgId && (!explicit || explicit === COLLECTION_NAME || explicit === 'BUNDB AGENT')) {
    return resolveCollectionForOrg(orgId);
  }
  if (explicit) return explicit;
  if (!PER_TENANT) return COLLECTION_NAME;
  return resolveCollectionForOrg(orgId);
}

// Boost extracted-fact memories — they have precise, focused embeddings
function applyFactMemoryBoost(results) {
  if (!results?.length) return results;
  return results.map(point => {
    const tags = point.payload?.tags || [];
    const isFactMemory = Array.isArray(tags) && tags.includes('extracted-fact');
    if (isFactMemory) {
      return { ...point, score: (point.score || 0) * 1.12 };
    }
    return point;
  }).sort((a, b) => (b.score || 0) - (a.score || 0));
}

export class QdrantClient {
  constructor() {
    this.collectionName = COLLECTION_NAME;
    // Factory: primary by EMBEDDING_PROVIDER, optionally wrapped with a fallback
    // (EMBEDDING_FALLBACK_PROVIDER) — e.g. prometheus bge-m3 primary → blaiq fallback.
    this.embedService = getEmbedService();
    this.dimension = parseInt(process.env.EMBEDDING_DIMENSION || '1024', 10);
    this.connected = null;
    this.collectionReady = null;
    this._litellmReady = null;
  }

  async ensureCollection(collectionName = this.collectionName) {
    if (this.collectionReady === collectionName) {
      return true;
    }

    try {
      const resolvedCollectionName = resolveCollectionName(collectionName);
      const response = await fetch(`${QDRANT_URL}/collections/${resolvedCollectionName}`, { headers });
      // getQdrantCollections takes positional args (url, apiKey, region) —
      // passing an object made `url` itself an object, blowing up later
      // with `url.startsWith is not a function`.
      const collections = getQdrantCollections(QDRANT_URL, API_KEY);

      if (response.ok) {
        await collections.ensureMemoriesCollectionIndexes(resolvedCollectionName);
        this.collectionReady = collectionName;
        return true;
      }

      if (response.status !== 404) {
        return false;
      }

      // Lazy-create backstop. ALL collections (org_<id>, HIVEMIND_PERSONAL, the
      // personal/default fallback) are per-tenant org containers and must be
      // created with the 1024 / m=32 / on_disk / int8-quant contract via
      // createOrgContainer. The legacy createMemoriesCollection (m=16, no on_disk)
      // is gone along with the BUNDB AGENT singleton.
      await collections.createOrgContainer(resolvedCollectionName);
      await collections.ensureMemoriesCollectionIndexes(resolvedCollectionName);
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
    // Wait for async LiteLLM init if needed
    if (this._litellmReady) await this._litellmReady;

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
   * Batch-embed many texts in one pass (the embed service chunks internally,
   * e.g. 20/req for bge-m3). Returns vectors aligned to inputs; on failure the
   * whole call throws so callers can degrade to no-vector upserts.
   * @param {string[]} texts
   * @returns {Promise<number[][]>} one vector per input, in order
   */
  async generateEmbeddings(texts) {
    if (this._litellmReady) await this._litellmReady;
    if (!this.embedService || !Array.isArray(texts) || texts.length === 0) return [];
    return this.embedService.embed(texts);
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

    const collectionName = await routeCollection({ explicit: options.collectionName, orgId: memory.org_id });
    const collectionReady = await this.ensureCollection(collectionName);
    if (!collectionReady) {
      console.warn('⚠️  Qdrant collection unavailable, storing in-memory only');
      return memory.id;
    }

    // Reuse precomputed embedding when supplied (knowledge upload pipeline
    // pre-embeds chunks in parallel before smart ingest to avoid re-embedding).
    let embedding = options.vector || null;

    if (!embedding) {
      // Contextual Retrieval: embed enriched key (facts + content), store raw content in payload
      let embeddingInput = memory.content || '';
      const pipelineFactSentences = memory.metadata?.factSentences || [];
      if (pipelineFactSentences.length > 0) {
        embeddingInput = pipelineFactSentences.join('. ') + '\n\n' + embeddingInput;
      } else {
        try {
          const { extractFacts, buildAugmentedKey } = await import('../memory/fact-extractor.js');
          const facts = await extractFacts(memory.content || '', { useLLM: false });
          embeddingInput = buildAugmentedKey(memory.content || '', facts);
        } catch (augErr) {
          console.warn('[qdrant] Fact extraction failed, using raw content:', augErr.message);
        }
      }
      embedding = await this.generateEmbedding(embeddingInput);
    }

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
        project_ids: Array.isArray(memory.project_ids) ? memory.project_ids : [],
        team_id: memory.primary_team_id || null,
        memory_type: memory.memory_type,
        tags: memory.tags || [],
        content: memory.content,
        is_latest: memory.is_latest ?? true,
        created_at: memory.created_at || new Date().toISOString(),
        source: memory.source || memory.source_metadata?.source_platform || null,
        source_platform: memory.source_metadata?.source_platform || memory.source || null,
        document_date: memory.document_date,
        event_dates: memory.event_dates || [],
        content_hash: memory.content_hash,
        relationship_type: memory.relationship_type,
        importance_score: memory.importance_score,
        strength: memory.strength,
        recall_count: memory.recall_count,
        visibility: memory.visibility,
        embedding_version: memory.embedding_version,
        temporal_status: memory.temporal_status,
        decay_factor: memory.decay_factor,
        // Layer discriminator — org containers hold memory + evidence in one
        // collection. Default 'memory'; evidence ingest passes options.layer.
        layer: options.layer || memory.layer || 'memory',
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
  async searchMemories({ query, vector, filter, limit = 10, score_threshold = DEFAULT_SCORE_THRESHOLD, collectionName, hnsw_ef, layer }) {
    // Check connection first
    const connected = await this.isConnected();
    if (!connected) {
      console.warn('⚠️  Qdrant unavailable, search returning empty results');
      return [];
    }

    // Route to the org container (org_<id>) / HIVEMIND_PERSONAL when per-tenant
    // is on and no explicit collection was given — derive org from the filter.
    const autoResolved = !collectionName && PER_TENANT;
    const resolvedCollection = await routeCollection({
      explicit: collectionName,
      orgId: filterMatchValue(filter, 'org_id')
    });

    // When we auto-routed into a shared org container, constrain to the memory
    // layer so evidence segments in the same collection don't leak into memory
    // recall. Explicit-collection callers (e.g. evidence-retrieval) own their
    // own layer filter and are left untouched.
    const effectiveLayer = layer ?? (autoResolved ? 'memory' : null);
    if (effectiveLayer && filter && Array.isArray(filter.must) && !filter.must.some((c) => c?.key === 'layer')) {
      filter = { ...filter, must: [...filter.must, { key: 'layer', match: { value: effectiveLayer } }] };
    }
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

    // P4: explicit search-time HNSW ef (recall/latency dial). Per-call
    // override wins; else the QDRANT_HNSW_EF default. Skip when ≤0.
    const effEf = Number.isFinite(hnsw_ef) ? hnsw_ef : EF_SEARCH_DEFAULT;
    if (effEf > 0) {
      searchRequest.params = { hnsw_ef: effEf };
    }
    // int8 quant rescore — search-time (NOT collection-creation): oversample the
    // quantized candidates, then re-score against full-precision vectors so the
    // delivered ranks aren't poisoned by int8 error. Graceful: Qdrant ignores
    // these on collections without quantization.
    if (QUANT_RESCORE) {
      searchRequest.params = { ...(searchRequest.params || {}), quantization: { rescore: true, oversampling: QUANT_OVERSAMPLING } };
    }

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

    // Add project_ids filter (V2 — array membership check on payload.project_ids)
    if (Array.isArray(filters.project_ids) && filters.project_ids.length > 0) {
      mustFilters.push({
        key: 'project_ids',
        match: { any: filters.project_ids }
      });
    } else if (typeof filters.project_id === 'string' && filters.project_id.trim()) {
      mustFilters.push({
        key: 'project_ids',
        match: { any: [filters.project_id.trim()] }
      });
    }

    // Add team_id filter (V2 — payload.team_id)
    if (typeof filters.team_id === 'string' && filters.team_id.trim()) {
      mustFilters.push({
        key: 'team_id',
        match: { value: filters.team_id.trim() }
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
      hnsw_ef: filters.hnsw_ef, // PHASE-F: thread per-org ef_search; inert when undefined (searchMemories → EF_SEARCH_DEFAULT). Dark-safe for all other hybridSearch callers.
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

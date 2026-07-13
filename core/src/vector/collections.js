/**
 * Qdrant Collections Management
 *
 * Creates and manages HIVE-MIND vector collections in Qdrant Cloud
 * Implements multi-tenant isolation with user_id filtering
 *
 * @module vector/collections
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { logger } from '../utils/logger.js';

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // Collection names
  collections: {
    memories: 'HIVEMIND_PERSONAL',
    sessions: process.env.QDRANT_SESSIONS_COLLECTION || 'hivemind_sessions'
  },

  // Vector configuration
  vectors: {
    dimension: parseInt(process.env.EMBEDDING_DIMENSION || '1024', 10),
    distance: 'Cosine'
  },

  // HNSW index configuration
  hnsw: {
    m: 16,
    ef_construct: 100,
    full_scan_threshold: 10000,
    max_indexing_threads: 8     // parallelize per-segment HNSW builds (was 2)
  },

  // Optimization configuration — tuned for 10M-scale ingest. NOTE: applies at
  // collection CREATION; existing collections need an update_collection
  // migration to pick these up.
  optimizers: {
    deleted_threshold: 0.1,        // tighter vacuum (was 0.2) → less bloat at 10M
    vacuum_min_vector_number: 1000,
    default_segment_number: 10,
    max_segment_size: 100000,
    memmap_threshold: 50000,       // keep more vectors in RAM (was 10000)
    indexing_threshold: 100000,    // re-index every ~100k inserts (was 10k → every ~6 min at 10M throughput)
    flush_interval_sec: 120,       // was 60
    max_optimization_threads: 4    // was 2
  },

  // WAL configuration
  wal: {
    wal_capacity_mb: 32,
    wal_segments_ahead: 0
  },

  // Quantization for storage efficiency
  quantization: {
    scalar: {
      type: 'int8',
      quantile: 0.99,
      always_ram: true
    }
  },

  // Replication and sharding
  replication: {
    shard_number: 2,
    replication_factor: 2,
    write_consistency_factor: 1
  }
};

// ==========================================
// Payload Index Definitions
// ==========================================

const MEMORIES_PAYLOAD_INDEXES = [
  {
    field_name: 'user_id',
    field_schema: 'keyword',
    description: 'Multi-tenant isolation - required for all queries',
    is_tenant_filter: true
  },
  {
    field_name: 'org_id',
    field_schema: 'keyword',
    description: 'Organization-level filtering'
  },
  {
    field_name: 'memory_type',
    field_schema: 'keyword',
    description: 'Memory type: fact, preference, decision, lesson, goal, event, relationship'
  },
  {
    field_name: 'tags',
    field_schema: 'keyword',
    description: 'User-defined tags for categorization'
  },
  {
    field_name: 'source_platform',
    field_schema: 'keyword',
    description: 'Source platform: chatgpt, claude, perplexity, gemini'
  },
  {
    field_name: 'temporal_status',
    field_schema: 'keyword',
    description: 'Temporal lifecycle status: active, expired, historical, archived'
  },
  {
    field_name: 'is_latest',
    field_schema: 'bool',
    description: 'Latest version flag for Updates relationship'
  },
  {
    field_name: 'document_date',
    field_schema: 'datetime',
    description: 'When the interaction occurred (dual-layer timestamp)'
  },
  {
    field_name: 'importance_score',
    field_schema: 'float',
    description: 'User/model assigned importance (0-1)'
  },
  {
    field_name: 'visibility',
    field_schema: 'keyword',
    description: 'Visibility scope: private, organization, public'
  },
  {
    field_name: 'strength',
    field_schema: 'float',
    description: 'Ebbinghaus memory strength for spaced repetition'
  },
  {
    field_name: 'recall_count',
    field_schema: 'integer',
    description: 'Number of times recalled for spaced repetition'
  },
  {
    field_name: 'embedding_version',
    field_schema: 'integer',
    description: 'Version for re-embedding when model changes'
  },
  {
    field_name: 'layer',
    field_schema: 'keyword',
    description: 'Layer discriminator within an org container: memory | evidence'
  },
  {
    field_name: 'project_id',
    field_schema: 'keyword',
    description: 'Project-level filtering — projects are shared inside an org container'
  }
];

// Payload indexes are schema setup, not query-path work. Keep successful
// initialization per process and share concurrent first requests per tenant.
const memoryIndexReady = new Map();

// Org-container HNSW/quant contract — MUST match the bge-m3 1024 migration
// (UWE_BERGER, CEYDA_SARIOGLU, AMAR_SAI, SEBASTIAN_GARN, HIVEMIND_PERSONAL).
// m=32/ef_construct=256, int8 always-RAM quant, on_disk vectors + payload.
// Single shard/replica — the prometheus box is single-node; shard_number>1 or
// replication_factor>1 only adds fd pressure with no failover benefit.
const ORG_CONTAINER_CONFIG = {
  hnsw: { m: 32, ef_construct: 256, full_scan_threshold: 10000, max_indexing_threads: 8 },
  shard_number: 1,
  replication_factor: 1,
  write_consistency_factor: 1
};

const SESSIONS_PAYLOAD_INDEXES = [
  {
    field_name: 'user_id',
    field_schema: 'keyword',
    description: 'Multi-tenant isolation for session embeddings',
    is_tenant_filter: true
  },
  {
    field_name: 'platform_type',
    field_schema: 'keyword',
    description: 'Platform type: chatgpt, claude, etc.'
  },
  {
    field_name: 'started_at',
    field_schema: 'datetime',
    description: 'Session start time'
  },
  {
    field_name: 'ended_at',
    field_schema: 'datetime',
    description: 'Session end time'
  },
  {
    field_name: 'message_count',
    field_schema: 'integer',
    description: 'Number of messages in session'
  }
];

// ==========================================
// Qdrant Collections Class
// ==========================================

export class QdrantCollections {
  #client;
  #config;

  constructor(config) {
    this.#config = {
      url: config.url,
      apiKey: config.apiKey,
      region: config.region || 'fr-par-1'
    };

    this.#client = new QdrantClient({
      url: this.#config.url,
      apiKey: this.#config.apiKey,
      headers: {
        'X-Qdrant-Client': 'hivemind/1.0',
        'X-Data-Residency': this.#config.region
      }
    });
  }

  /**
   * Verify connection to Qdrant Cloud
   */
  async healthCheck() {
    try {
      const health = await this.#client.health();
      logger.info('Qdrant health check', {
        status: health.status,
        version: health.version,
        region: this.#config.region
      });
      return true;
    } catch (error) {
      logger.error('Qdrant health check failed', {
        error: error instanceof Error ? error.message : String(error),
        url: this.#config.url
      });
      return false;
    }
  }

  /**
   * Check if a collection exists
   */
  async collectionExists(collectionName) {
    try {
      const collections = await this.#client.getCollections();
      return collections.collections.some(c => c.name === collectionName);
    } catch (error) {
      logger.error('Failed to list collections', { error });
      throw error;
    }
  }

  /**
   * Create memories collection with all payload indexes
   */
  async createMemoriesCollection() {
    const collectionName = CONFIG.collections.memories;

    if (await this.collectionExists(collectionName)) {
      logger.info(`Collection ${collectionName} already exists`);
      return;
    }

    logger.info(`Creating collection: ${collectionName}`);

    try {
      await this.#client.createCollection(collectionName, {
        vectors: {
          size: CONFIG.vectors.dimension,
          distance: CONFIG.vectors.distance,
          on_disk: false
        },
        hnsw_config: {
          m: CONFIG.hnsw.m,
          ef_construct: CONFIG.hnsw.ef_construct,
          full_scan_threshold: CONFIG.hnsw.full_scan_threshold,
          max_indexing_threads: CONFIG.hnsw.max_indexing_threads,
          on_disk: false
        },
        optimizers_config: {
          deleted_threshold: CONFIG.optimizers.deleted_threshold,
          vacuum_min_vector_number: CONFIG.optimizers.vacuum_min_vector_number,
          default_segment_number: CONFIG.optimizers.default_segment_number,
          max_segment_size: CONFIG.optimizers.max_segment_size,
          memmap_threshold: CONFIG.optimizers.memmap_threshold,
          indexing_threshold: CONFIG.optimizers.indexing_threshold,
          flush_interval_sec: CONFIG.optimizers.flush_interval_sec,
          max_optimization_threads: CONFIG.optimizers.max_optimization_threads
        },
        wal_config: {
          wal_capacity_mb: CONFIG.wal.wal_capacity_mb,
          wal_segments_ahead: CONFIG.wal.wal_segments_ahead
        },
        quantization_config: CONFIG.quantization,
        shard_number: CONFIG.replication.shard_number,
        replication_factor: CONFIG.replication.replication_factor,
        write_consistency_factor: CONFIG.replication.write_consistency_factor
      });

      logger.info(`Collection ${collectionName} created successfully`);

      // Create payload indexes
      await this.createPayloadIndexes(collectionName, MEMORIES_PAYLOAD_INDEXES);

      logger.info(`Payload indexes created for ${collectionName}`);
    } catch (error) {
      logger.error(`Failed to create collection ${collectionName}`, { error });
      throw error;
    }
  }

  /**
   * Create an org container (per-organization memory+evidence collection).
   * Idempotent — no-op if the collection already exists. Uses the 1024-dim
   * bge-m3 migration contract (m=32/ef=256, int8 quant, on_disk).
   * @param {string} collectionName e.g. `org_<orgId>`
   * @returns {Promise<boolean>} true if created or already present
   */
  async createOrgContainer(collectionName) {
    if (!collectionName) throw new Error('createOrgContainer: collectionName required');

    if (await this.collectionExists(collectionName)) {
      logger.info(`Org container ${collectionName} already exists`);
      return true;
    }

    logger.info(`Creating org container: ${collectionName}`);
    await this.#client.createCollection(collectionName, {
      vectors: {
        size: CONFIG.vectors.dimension,
        distance: CONFIG.vectors.distance,
        on_disk: true
      },
      hnsw_config: {
        m: ORG_CONTAINER_CONFIG.hnsw.m,
        ef_construct: ORG_CONTAINER_CONFIG.hnsw.ef_construct,
        full_scan_threshold: ORG_CONTAINER_CONFIG.hnsw.full_scan_threshold,
        max_indexing_threads: ORG_CONTAINER_CONFIG.hnsw.max_indexing_threads,
        on_disk: true
      },
      optimizers_config: {
        deleted_threshold: CONFIG.optimizers.deleted_threshold,
        vacuum_min_vector_number: CONFIG.optimizers.vacuum_min_vector_number,
        default_segment_number: CONFIG.optimizers.default_segment_number,
        memmap_threshold: CONFIG.optimizers.memmap_threshold,
        indexing_threshold: CONFIG.optimizers.indexing_threshold
      },
      quantization_config: CONFIG.quantization,
      on_disk_payload: true,
      shard_number: ORG_CONTAINER_CONFIG.shard_number,
      replication_factor: ORG_CONTAINER_CONFIG.replication_factor,
      write_consistency_factor: ORG_CONTAINER_CONFIG.write_consistency_factor
    });

    logger.info(`Org container ${collectionName} created — installing payload indexes`);
    await this.createPayloadIndexes(collectionName, MEMORIES_PAYLOAD_INDEXES);
    memoryIndexReady.set(collectionName, Promise.resolve());
    logger.info(`Org container ${collectionName} ready`);
    return true;
  }

  /**
   * Create sessions collection
   */
  async createSessionsCollection() {
    const collectionName = CONFIG.collections.sessions;

    if (await this.collectionExists(collectionName)) {
      logger.info(`Collection ${collectionName} already exists`);
      return;
    }

    logger.info(`Creating collection: ${collectionName}`);

    try {
      await this.#client.createCollection(collectionName, {
        vectors: {
          size: CONFIG.vectors.dimension,
          distance: CONFIG.vectors.distance,
          on_disk: false
        },
        hnsw_config: {
          m: CONFIG.hnsw.m,
          ef_construct: CONFIG.hnsw.ef_construct,
          full_scan_threshold: CONFIG.hnsw.full_scan_threshold
        },
        shard_number: 1,
        replication_factor: CONFIG.replication.replication_factor
      });

      logger.info(`Collection ${collectionName} created successfully`);

      // Create payload indexes
      await this.createPayloadIndexes(collectionName, SESSIONS_PAYLOAD_INDEXES);

      logger.info(`Payload indexes created for ${collectionName}`);
    } catch (error) {
      logger.error(`Failed to create collection ${collectionName}`, { error });
      throw error;
    }
  }

  /**
   * Create payload indexes for a collection
   */
  async createPayloadIndexes(
    collectionName,
    indexes
  ) {
    for (const index of indexes) {
      try {
        await this.#client.createPayloadIndex(collectionName, {
          field_name: index.field_name,
          field_schema: index.field_schema,
          wait: true
        });
        logger.debug(`Payload index created: ${collectionName}.${index.field_name}`, {
          schema: index.field_schema,
          isTenantFilter: index.is_tenant_filter
        });
      } catch (error) {
        // Check if index already exists
        const collections = await this.#client.getCollections();
        const collection = collections.collections.find(c => c.name === collectionName);
        if (collection && collection.payload_schema?.[index.field_name]) {
          logger.debug(`Payload index ${index.field_name} already exists`);
        } else {
          logger.error(`Failed to create payload index ${index.field_name}`, { error });
          throw error;
        }
      }
    }
  }

  /**
   * Ensure payload indexes exist for an already-created memories collection.
   */
  async ensureMemoriesCollectionIndexes(collectionName = CONFIG.collections.memories) {
    const ready = memoryIndexReady.get(collectionName);
    if (ready) return ready;

    const initialization = (async () => {
      if (!(await this.collectionExists(collectionName))) {
        logger.warn(`Collection ${collectionName} does not exist yet; skipping index sync`);
        return;
      }

      await this.createPayloadIndexes(collectionName, MEMORIES_PAYLOAD_INDEXES);
    })();

    memoryIndexReady.set(collectionName, initialization);
    try {
      await initialization;
    } catch (error) {
      // A failed setup must be retryable rather than poisoning this process.
      memoryIndexReady.delete(collectionName);
      throw error;
    }
  }

  /**
   * Create all HIVE-MIND collections
   */
  async createAllCollections() {
    // Per-tenant only: memory collections (org_<id> / HIVEMIND_PERSONAL) are
    // created on demand by ensureCollection → createOrgContainer with the
    // 1024 / m=32 / on_disk / int8-quant contract. The legacy 'BUNDB AGENT'
    // memories singleton and the unused 'hivemind_sessions' collection are
    // no longer bootstrapped (removed). Nothing to pre-create at boot.
    logger.info('Per-tenant collections created on demand (no legacy bootstrap)');
  }

  /**
   * Get collection statistics
   */
  async getCollectionStats(collectionName) {
    try {
      const info = await this.#client.getCollection(collectionName);

      return {
        collectionName: info.name,
        vectorCount: info.points_count,
        segmentCount: info.segments_count,
        indexedVectors: info.indexed_vectors_count,
        status: info.status,
        payloadSchema: info.payload_schema,
        shardCount: info.shard_count,
        replicationFactor: info.replication_factor
      };
    } catch (error) {
      logger.error(`Failed to get collection stats for ${collectionName}`, { error });
      throw error;
    }
  }

  /**
   * Get all collection statistics
   */
  async getAllCollectionStats() {
    const stats = {};

    for (const collectionName of Object.values(CONFIG.collections)) {
      stats[collectionName] = await this.getCollectionStats(collectionName);
    }

    return stats;
  }

  /**
   * Delete a collection
   */
  async deleteCollection(collectionName) {
    try {
      await this.#client.deleteCollection(collectionName);
      logger.info(`Collection deleted: ${collectionName}`);
    } catch (error) {
      logger.error(`Failed to delete collection ${collectionName}`, { error });
      throw error;
    }
  }

  /**
   * Drop all collections (for reset/debug)
   */
  async dropAllCollections() {
    logger.warn('Dropping all HIVE-MIND collections');

    for (const collectionName of Object.values(CONFIG.collections)) {
      if (await this.collectionExists(collectionName)) {
        await this.deleteCollection(collectionName);
      }
    }

    logger.info('All HIVE-MIND collections dropped');
  }

  /**
   * Get client instance
   */
  getClient() {
    return this.#client;
  }

  /**
   * Get configuration
   */
  getConfig() {
    return this.#config;
  }
}

// ==========================================
// Singleton Pattern
// ==========================================

let collectionsInstance = null;

/**
 * Get or create QdrantCollections singleton
 */
export function getQdrantCollections(
  url,
  apiKey,
  region
) {
  if (!collectionsInstance) {
    collectionsInstance = new QdrantCollections({
      url: url || process.env.QDRANT_URL,
      apiKey: apiKey || process.env.QDRANT_API_KEY,
      region: region || 'fr-par-1'
    });
  }
  return collectionsInstance;
}

// ==========================================
// Export Configuration
// ==========================================

export { CONFIG };

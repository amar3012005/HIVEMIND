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
    memories: process.env.QDRANT_COLLECTION || 'BUNDB AGENT',
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
    max_indexing_threads: 2
  },

  // Optimization configuration
  optimizers: {
    deleted_threshold: 0.2,
    vacuum_min_vector_number: 1000,
    default_segment_number: 10,
    max_segment_size: 100000,
    memmap_threshold: 10000,
    indexing_threshold: 10000,
    flush_interval_sec: 60,
    max_optimization_threads: 2
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
  }
];

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
    if (!(await this.collectionExists(collectionName))) {
      logger.warn(`Collection ${collectionName} does not exist yet; skipping index sync`);
      return;
    }

    await this.createPayloadIndexes(collectionName, MEMORIES_PAYLOAD_INDEXES);
  }

  /**
   * Create all HIVE-MIND collections
   */
  async createAllCollections() {
    logger.info('Creating HIVE-MIND collections', {
      region: this.#config.region,
      collections: [CONFIG.collections.memories, CONFIG.collections.sessions]
    });

    await this.createMemoriesCollection();
    await this.createSessionsCollection();

    logger.info('All HIVE-MIND collections created successfully');
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

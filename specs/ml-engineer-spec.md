# Phase 1 Implementation Specification: ML Engineer

**Document Version:** 1.0.0  
**Role:** ML Engineer  
**Estimated Duration:** 10-14 days  
**Priority:** Critical (Intelligence Layer)  
**Compliance Reference:** CROSS_PLATFORM_SYNC_SPEC.md §1.2  

---

## Executive Summary

This specification defines the machine learning implementation for HIVE-MIND's semantic memory system. You will set up **Qdrant Cloud** (EU region), integrate **Mistral-embed** for 1024-dimension vectors, implement **vector indexing** with tenant filtering, build the **recall scoring algorithm** with Ebbinghaus decay, establish **embedding caching**, and create an **A/B testing framework** for recall quality.

### Key Deliverables

1. ✅ Qdrant Cloud setup (FR-Paris region)
2. ✅ Mistral-embed integration (1024-dimension vectors)
3. ✅ Vector indexing strategy with user_id tenant filtering
4. ✅ Recall scoring algorithm (similarity + recency bias)
5. ✅ Ebbinghaus decay optimization
6. ✅ Embedding caching strategy
7. ✅ A/B testing framework for recall quality

---

## 1. Qdrant Cloud Setup

### 1.1 Collection Configuration

```typescript
// File: ml/qdrant/qdrant-setup.ts

import { QdrantClient, Schemas } from '@qdrant/js-client-rest';

interface QdrantConfig {
  url: string;
  apiKey: string;
  region: 'eu-central' | 'eu-west';
}

/**
 * Initialize Qdrant Cloud collections for HIVE-MIND
 */
export async function setupQdrantCollections(config: QdrantConfig): Promise<void> {
  const client = new QdrantClient({
    url: config.url,
    apiKey: config.apiKey,
  });

  // Verify connection
  const health = await client.health();
  console.log('Qdrant connection established:', health);

  // ==========================================
  // MEMORIES COLLECTION
  // ==========================================
  const memoriesCollection = 'hivemind_memories';

  // Check if collection exists
  const collections = await client.getCollections();
  const exists = collections.collections.some(c => c.name === memoriesCollection);

  if (!exists) {
    console.log(`Creating collection: ${memoriesCollection}`);

    await client.createCollection(memoriesCollection, {
      vectors: {
        size: 1024, // Mistral-embed dimension
        distance: 'Cosine',
      },
      hnsw_config: {
        m: 16, // Number of connections per node
        ef_construct: 100, // Size of dynamic candidate list
        full_scan_threshold: 10000, // Threshold for full scan
        max_indexing_threads: 2,
        on_disk: false,
      },
      optimizers_config: {
        deleted_threshold: 0.2,
        vacuum_min_vector_number: 1000,
        default_segment_number: 10,
        max_segment_size: 100000,
        memmap_threshold: 10000,
        indexing_threshold: 10000,
        flush_interval_sec: 60,
        max_optimization_threads: 2,
      },
      wal_config: {
        wal_capacity_mb: 32,
        wal_segments_ahead: 0,
      },
      quantization_config: {
        scalar: {
          type: 'int8',
          quantile: 0.99,
          always_ram: true,
        },
      },
      shard_number: 2, // Multi-shard for multi-tenant
      replication_factor: 2, // High availability
      write_consistency_factor: 1,
    });

    // Create payload indexes for filtering
    await client.createPayloadIndex(memoriesCollection, {
      field_name: 'user_id',
      field_schema: 'keyword',
      wait: true,
    });

    await client.createPayloadIndex(memoriesCollection, {
      field_name: 'org_id',
      field_schema: 'keyword',
      wait: true,
    });

    await client.createPayloadIndex(memoriesCollection, {
      field_name: 'memory_type',
      field_schema: 'keyword',
      wait: true,
    });

    await client.createPayloadIndex(memoriesCollection, {
      field_name: 'tags',
      field_schema: 'keyword',
      wait: true,
    });

    await client.createPayloadIndex(memoriesCollection, {
      field_name: 'source_platform',
      field_schema: 'keyword',
      wait: true,
    });

    await client.createPayloadIndex(memoriesCollection, {
      field_name: 'is_latest',
      field_schema: 'bool',
      wait: true,
    });

    await client.createPayloadIndex(memoriesCollection, {
      field_name: 'document_date',
      field_schema: 'datetime',
      wait: true,
    });

    await client.createPayloadIndex(memoriesCollection, {
      field_name: 'importance_score',
      field_schema: 'float',
      wait: true,
    });

    await client.createPayloadIndex(memoriesCollection, {
      field_name: 'visibility',
      field_schema: 'keyword',
      wait: true,
    });

    console.log(`Collection ${memoriesCollection} created with indexes`);
  } else {
    console.log(`Collection ${memoriesCollection} already exists`);
  }

  // ==========================================
  // SESSIONS COLLECTION (for session embeddings)
  // ==========================================
  const sessionsCollection = 'hivemind_sessions';

  const sessionsExists = collections.collections.some(c => c.name === sessionsCollection);

  if (!sessionsExists) {
    console.log(`Creating collection: ${sessionsCollection}`);

    await client.createCollection(sessionsCollection, {
      vectors: {
        size: 1024,
        distance: 'Cosine',
      },
      hnsw_config: {
        m: 16,
        ef_construct: 100,
        full_scan_threshold: 10000,
      },
      shard_number: 1,
      replication_factor: 2,
    });

    await client.createPayloadIndex(sessionsCollection, {
      field_name: 'user_id',
      field_schema: 'keyword',
      wait: true,
    });

    await client.createPayloadIndex(sessionsCollection, {
      field_name: 'platform_type',
      field_schema: 'keyword',
      wait: true,
    });

    await client.createPayloadIndex(sessionsCollection, {
      field_name: 'started_at',
      field_schema: 'datetime',
      wait: true,
    });

    console.log(`Collection ${sessionsCollection} created`);
  }
}

/**
 * Get collection statistics
 */
export async function getCollectionStats(client: QdrantClient, collection: string): Promise<any> {
  const info = await client.getCollection(collection);

  return {
    vectorCount: info.points_count,
    segmentCount: info.segments_count,
    indexedVectors: info.indexed_vectors_count,
    status: info.status,
  };
}

// Usage
// setupQdrantCollections({
//   url: 'https://hivemind-fr-par-1.cloud.qdrant.io',
//   apiKey: process.env.QDRANT_API_KEY!,
//   region: 'eu-central',
// });
```

### 1.2 Qdrant Client Wrapper

```typescript
// File: ml/qdrant/qdrant-client.ts

import { QdrantClient, Schemas } from '@qdrant/js-client-rest';
import { logger } from '../../core/src/utils/logger';

interface SearchParams {
  collection: string;
  vector: number[];
  filter?: Schemas['Filter'];
  limit?: number;
  offset?: number;
  scoreThreshold?: number;
  withPayload?: boolean | string[];
  withVector?: boolean;
}

interface SearchResult {
  id: string;
  score: number;
  payload: Record<string, any>;
  vector?: number[];
}

interface UpsertParams {
  collection: string;
  id: string;
  vector: number[];
  payload: Record<string, any>;
}

export class HivemindQdrantClient {
  private client: QdrantClient;

  constructor(url: string, apiKey: string) {
    this.client = new QdrantClient({
      url,
      apiKey,
      headers: {
        'X-Qdrant-Client': 'hivemind/1.0',
      },
    });
  }

  /**
   * Upsert a single point
   */
  async upsert(params: UpsertParams): Promise<void> {
    try {
      await this.client.upsert(params.collection, {
        points: [
          {
            id: params.id,
            vector: params.vector,
            payload: params.payload,
          },
        ],
        wait: true,
      });

      logger.debug('Qdrant point upserted', {
        collection: params.collection,
        id: params.id,
      });
    } catch (error) {
      logger.error('Qdrant upsert failed', { error, params });
      throw error;
    }
  }

  /**
   * Batch upsert points
   */
  async upsertBatch(params: {
    collection: string;
    points: Array<{
      id: string;
      vector: number[];
      payload: Record<string, any>;
    }>;
  }): Promise<void> {
    try {
      // Process in batches of 100
      const batchSize = 100;
      for (let i = 0; i < params.points.length; i += batchSize) {
        const batch = params.points.slice(i, i + batchSize);

        await this.client.upsert(params.collection, {
          points: batch,
          wait: true,
        });

        logger.debug('Qdrant batch upserted', {
          collection: params.collection,
          batchNumber: Math.floor(i / batchSize) + 1,
          batchSize: batch.length,
        });
      }
    } catch (error) {
      logger.error('Qdrant batch upsert failed', { error });
      throw error;
    }
  }

  /**
   * Search with filtering
   */
  async search(params: SearchParams): Promise<SearchResult[]> {
    try {
      const result = await this.client.search(params.collection, {
        vector: params.vector,
        filter: params.filter,
        limit: params.limit ?? 10,
        offset: params.offset,
        score_threshold: params.scoreThreshold,
        with_payload: params.withPayload ?? true,
        with_vector: params.withVector ?? false,
      });

      return result.map(r => ({
        id: r.id as string,
        score: r.score,
        payload: r.payload as Record<string, any>,
        vector: r.vector,
      }));
    } catch (error) {
      logger.error('Qdrant search failed', { error, params });
      throw error;
    }
  }

  /**
   * Search with multi-vector fusion
   */
  async searchWithFusion(params: {
    collection: string;
    queries: Array<{
      vector: number[];
      weight?: number;
    }>;
    filter?: Schemas['Filter'];
    limit?: number;
  }): Promise<SearchResult[]> {
    try {
      // Perform searches for each query vector
      const allResults = await Promise.all(
        params.queries.map(q =>
          this.client.search(params.collection, {
            vector: q.vector,
            filter: params.filter,
            limit: params.limit ?? 10,
            with_payload: true,
          })
        )
      );

      // Fuse results with weighted scoring
      const fusedScores = new Map<string, { score: number; payload: Record<string, any> }>();

      allResults.forEach((results, queryIndex) => {
        const weight = params.queries[queryIndex].weight ?? 1.0;

        results.forEach(r => {
          const id = r.id as string;
          const existing = fusedScores.get(id);

          if (existing) {
            existing.score += r.score * weight;
          } else {
            fusedScores.set(id, {
              score: r.score * weight,
              payload: r.payload as Record<string, any>,
            });
          }
        });
      });

      // Sort and return
      return Array.from(fusedScores.entries())
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, params.limit ?? 10)
        .map(([id, data]) => ({
          id,
          score: data.score,
          payload: data.payload,
        }));
    } catch (error) {
      logger.error('Qdrant fusion search failed', { error });
      throw error;
    }
  }

  /**
   * Delete a point
   */
  async delete(collection: string, id: string): Promise<void> {
    try {
      await this.client.delete(collection, {
        points: [id],
        wait: true,
      });

      logger.debug('Qdrant point deleted', { collection, id });
    } catch (error) {
      logger.error('Qdrant delete failed', { error, collection, id });
      throw error;
    }
  }

  /**
   * Delete by filter
   */
  async deleteByFilter(collection: string, filter: Schemas['Filter']): Promise<void> {
    try {
      await this.client.delete(collection, {
        filter,
        wait: true,
      });

      logger.debug('Qdrant points deleted by filter', { collection });
    } catch (error) {
      logger.error('Qdrant delete by filter failed', { error });
      throw error;
    }
  }

  /**
   * Get point by ID
   */
  async get(collection: string, id: string): Promise<SearchResult | null> {
    try {
      const result = await this.client.retrieve(collection, {
        ids: [id],
        with_payload: true,
        with_vector: false,
      });

      if (result.length === 0) return null;

      return {
        id: result[0].id as string,
        score: 1.0,
        payload: result[0].payload as Record<string, any>,
      };
    } catch (error) {
      logger.error('Qdrant get failed', { error, collection, id });
      throw error;
    }
  }

  /**
   * Count points with filter
   */
  async count(collection: string, filter?: Schemas['Filter']): Promise<number> {
    try {
      const result = await this.client.count(collection, {
        filter,
        exact: true,
      });

      return result.count;
    } catch (error) {
      logger.error('Qdrant count failed', { error });
      throw error;
    }
  }

  /**
   * Update payload
   */
  async updatePayload(
    collection: string,
    id: string,
    payload: Record<string, any>
  ): Promise<void> {
    try {
      await this.client.setPayload(collection, {
        points: [id],
        payload,
      });

      logger.debug('Qdrant payload updated', { collection, id });
    } catch (error) {
      logger.error('Qdrant payload update failed', { error });
      throw error;
    }
  }

  /**
   * Health check
   */
  async health(): Promise<any> {
    return this.client.health();
  }
}

// Singleton
let qdrantClient: HivemindQdrantClient | null = null;

export function getQdrantClient(): HivemindQdrantClient {
  if (!qdrantClient) {
    qdrantClient = new HivemindQdrantClient(
      process.env.QDRANT_URL!,
      process.env.QDRANT_API_KEY!
    );
  }
  return qdrantClient;
}
```

---

## 2. Mistral-Embed Integration

### 2.1 Embedding Service

```typescript
// File: ml/embeddings/mistral-embed.ts

import { logger } from '../../core/src/utils/logger';

interface MistralConfig {
  apiKey: string;
  endpoint: string;
  model: string;
  batchSize: number;
  maxRetries: number;
}

interface EmbeddingResult {
  embedding: number[];
  model: string;
  usage: {
    promptTokens: number;
    totalTokens: number;
  };
}

interface BatchEmbeddingResult {
  embeddings: number[][];
  model: string;
  usage: {
    promptTokens: number;
    totalTokens: number;
  };
}

export class MistralEmbedService {
  private config: MistralConfig;
  private cache: Map<string, number[]>;

  constructor(config?: Partial<MistralConfig>) {
    this.config = {
      apiKey: process.env.MISTRAL_API_KEY!,
      endpoint: 'https://api.mistral.ai/v1',
      model: 'mistral-embed',
      batchSize: 100,
      maxRetries: 3,
      ...config,
    };

    // Initialize embedding cache
    this.cache = new Map();
  }

  /**
   * Generate embedding for single text
   */
  async embed(text: string, cacheKey?: string): Promise<EmbeddingResult> {
    const cacheLookupKey = cacheKey || `text:${this.hashText(text)}`;

    // Check cache first
    const cached = this.cache.get(cacheLookupKey);
    if (cached) {
      logger.debug('Embedding cache hit', { textLength: text.length });
      return {
        embedding: cached,
        model: this.config.model,
        usage: { promptTokens: 0, totalTokens: 0 },
      };
    }

    // Validate input length
    if (text.length > 8192) {
      throw new Error('Text exceeds maximum length of 8192 characters');
    }

    // Make API request with retry
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.config.endpoint}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            input: text,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Mistral API error: ${response.status} - ${error}`);
        }

        const data = await response.json();

        const result: EmbeddingResult = {
          embedding: data.data[0].embedding,
          model: data.model,
          usage: data.usage,
        };

        // Cache result
        this.cache.set(cacheLookupKey, result.embedding);

        logger.debug('Embedding generated', {
          textLength: text.length,
          dimension: result.embedding.length,
          tokens: result.usage.totalTokens,
        });

        return result;
      } catch (error) {
        lastError = error as Error;
        logger.warning(`Embedding attempt ${attempt} failed`, { error });

        if (attempt < this.config.maxRetries) {
          // Exponential backoff
          await this.sleep(Math.pow(2, attempt) * 1000);
        }
      }
    }

    logger.error('Embedding failed after all retries', { error: lastError });
    throw lastError;
  }

  /**
   * Generate embeddings for batch of texts
   */
  async embedBatch(texts: string[]): Promise<BatchEmbeddingResult> {
    if (texts.length === 0) {
      return {
        embeddings: [],
        model: this.config.model,
        usage: { promptTokens: 0, totalTokens: 0 },
      };
    }

    // Check cache for each text
    const cachedIndices: number[] = [];
    const cachedEmbeddings: (number[] | null)[] = new Array(texts.length).fill(null);
    const textsToEmbed: string[] = [];
    const indicesToEmbed: number[] = [];

    texts.forEach((text, index) => {
      const cacheKey = `text:${this.hashText(text)}`;
      const cached = this.cache.get(cacheKey);

      if (cached) {
        cachedIndices.push(index);
        cachedEmbeddings[index] = cached;
      } else {
        textsToEmbed.push(text);
        indicesToEmbed.push(index);
      }
    });

    logger.debug('Batch embedding cache', {
      total: texts.length,
      cached: cachedIndices.length,
      toEmbed: textsToEmbed.length,
    });

    // If all cached, return early
    if (textsToEmbed.length === 0) {
      return {
        embeddings: cachedEmbeddings as number[][],
        model: this.config.model,
        usage: { promptTokens: 0, totalTokens: 0 },
      };
    }

    // Process in batches
    const batchSize = this.config.batchSize;
    const allEmbeddings: (number[] | null)[] = [...cachedEmbeddings];
    let totalPromptTokens = 0;
    let totalTokens = 0;

    for (let i = 0; i < textsToEmbed.length; i += batchSize) {
      const batch = textsToEmbed.slice(i, i + batchSize);
      const batchIndices = indicesToEmbed.slice(i, i + batchSize);

      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
        try {
          const response = await fetch(`${this.config.endpoint}/embeddings`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify({
              model: this.config.model,
              input: batch,
            }),
          });

          if (!response.ok) {
            const error = await response.text();
            throw new Error(`Mistral API error: ${response.status} - ${error}`);
          }

          const data = await response.json();

          // Map embeddings back to original indices
          data.data.forEach((item: any, batchIndex: number) => {
            const originalIndex = batchIndices[batchIndex];
            allEmbeddings[originalIndex] = item.embedding;

            // Cache
            const cacheKey = `text:${this.hashText(texts[originalIndex])}`;
            this.cache.set(cacheKey, item.embedding);
          });

          totalPromptTokens += data.usage.prompt_tokens;
          totalTokens += data.usage.total_tokens;

          break;
        } catch (error) {
          lastError = error as Error;
          logger.warning(`Batch embedding attempt ${attempt} failed`, {
            batchNumber: Math.floor(i / batchSize) + 1,
          });

          if (attempt < this.config.maxRetries) {
            await this.sleep(Math.pow(2, attempt) * 1000);
          }
        }
      }

      if (lastError) {
        throw lastError;
      }
    }

    return {
      embeddings: allEmbeddings as number[][],
      model: this.config.model,
      usage: {
        promptTokens: totalPromptTokens,
        totalTokens: totalTokens,
      },
    };
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; hits: number; misses: number } {
    return {
      size: this.cache.size,
      hits: 0, // Would need to track separately
      misses: 0,
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    logger.info('Embedding cache cleared');
  }

  /**
   * Simple hash function for cache keys
   */
  private hashText(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton
let mistralEmbedService: MistralEmbedService | null = null;

export function getMistralEmbedService(): MistralEmbedService {
  if (!mistralEmbedService) {
    mistralEmbedService = new MistralEmbedService();
  }
  return mistralEmbedService;
}
```

### 2.2 Embedding Pipeline

```typescript
// File: ml/embeddings/embedding-pipeline.ts

import { getMistralEmbedService } from './mistral-embed';
import { getQdrantClient } from '../qdrant/qdrant-client';
import { PrismaClient } from '@prisma/client';
import { logger } from '../../core/src/utils/logger';

const prisma = new PrismaClient();

interface MemoryForEmbedding {
  id: string;
  content: string;
  userId: string;
  memoryType: string;
  tags: string[];
  documentDate: Date;
  importanceScore: number;
}

/**
 * Process memories for embedding
 */
export async function processEmbeddingQueue(): Promise<void> {
  const embedService = getMistralEmbedService();
  const qdrant = getQdrantClient();

  try {
    // Get memories pending embedding
    const pendingMemories = await prisma.memory.findMany({
      where: {
        vectorEmbedding: {
          is: null,
        },
        deletedAt: null,
      },
      take: 100,
    });

    if (pendingMemories.length === 0) {
      logger.debug('No pending embeddings');
      return;
    }

    logger.info('Processing embedding queue', { count: pendingMemories.length });

    // Prepare texts for batch embedding
    const texts = pendingMemories.map(m => prepareTextForEmbedding(m));

    // Generate embeddings
    const result = await embedService.embedBatch(texts);

    // Upsert to Qdrant and create records
    for (let i = 0; i < pendingMemories.length; i++) {
      const memory = pendingMemories[i];
      const embedding = result.embeddings[i];

      if (!embedding) continue;

      // Upsert to Qdrant
      await qdrant.upsert({
        collection: 'hivemind_memories',
        id: memory.id,
        vector: embedding,
        payload: {
          user_id: memory.userId,
          memory_id: memory.id,
          content: memory.content,
          memory_type: memory.memoryType,
          tags: memory.tags,
          source_platform: memory.sourcePlatform,
          document_date: memory.documentDate.toISOString(),
          importance_score: memory.importanceScore,
          is_latest: memory.isLatest,
          visibility: memory.visibility,
        },
      });

      // Create vector embedding record
      await prisma.vectorEmbedding.create({
        data: {
          memoryId: memory.id,
          qdrantCollection: 'hivemind_memories',
          qdrantPointId: memory.id,
          syncStatus: 'synced',
        },
      });

      logger.debug('Memory embedded', { memoryId: memory.id });
    }

    logger.info('Embedding queue processed', {
      processed: pendingMemories.length,
      tokensUsed: result.usage.totalTokens,
    });
  } catch (error) {
    logger.error('Embedding queue processing failed', { error });
    throw error;
  }
}

/**
 * Prepare text for embedding with context
 */
function prepareTextForEmbedding(memory: MemoryForEmbedding): string {
  // Add context to improve embedding quality
  const parts = [
    `[Type: ${memory.memoryType}]`,
    memory.content,
  ];

  if (memory.tags.length > 0) {
    parts.push(`[Tags: ${memory.tags.join(', ')}]`);
  }

  return parts.join(' ');
}

/**
 * Re-embed memories with new model version
 */
export async function reembedMemories(params: {
  userId?: string;
  memoryType?: string;
  olderThan?: Date;
}): Promise<void> {
  const embedService = getMistralEmbedService();
  const qdrant = getQdrantClient();

  const where: any = {
    deletedAt: null,
    vectorEmbedding: {
      isNot: null,
    },
  };

  if (params.userId) where.userId = params.userId;
  if (params.memoryType) where.memoryType = params.memoryType;
  if (params.olderThan) {
    where.vectorEmbedding = {
      ...where.vectorEmbedding,
      lastReembeddedAt: {
        lt: params.olderThan,
      },
    };
  }

  const memories = await prisma.memory.findMany({
    where,
    include: { vectorEmbedding: true },
    take: 1000,
  });

  logger.info('Re-embedding memories', { count: memories.length });

  const texts = memories.map(m => prepareTextForEmbedding(m));
  const result = await embedService.embedBatch(texts);

  for (let i = 0; i < memories.length; i++) {
    const memory = memories[i];
    const embedding = result.embeddings[i];

    if (!embedding) continue;

    // Update Qdrant
    await qdrant.upsert({
      collection: 'hivemind_memories',
      id: memory.id,
      vector: embedding,
      payload: {
        ...memory,
        document_date: memory.documentDate.toISOString(),
      },
    });

    // Update record
    await prisma.vectorEmbedding.update({
      where: { memoryId: memory.id },
      data: {
        embeddingVersion: 2,
        lastReembeddedAt: new Date(),
        syncStatus: 'synced',
      },
    });
  }

  logger.info('Re-embedding complete', { count: memories.length });
}
```

---

## 3. Recall Scoring Algorithm

### 3.1 Recall Service with Scoring

```typescript
// File: ml/recall/recall.service.ts

import { getQdrantClient } from '../qdrant/qdrant-client';
import { getMistralEmbedService } from '../embeddings/mistral-embed';
import { PrismaClient } from '@prisma/client';
import { logger } from '../../core/src/utils/logger';

const prisma = new PrismaClient();

interface RecallSearchParams {
  userId: string;
  query: string;
  limit?: number;
  memoryTypes?: string[];
  sourcePlatform?: string;
  minImportance?: number;
  recencyBias?: number; // 0-1, higher = more weight on recent
  timeDecayHalfLife?: number; // Days for score to halve
}

interface RecallResult {
  id: string;
  content: string;
  memoryType: string;
  title?: string;
  tags: string[];
  sourcePlatform?: string;
  documentDate: Date;
  importanceScore: number;
  scores: {
    vector: number;
    recency: number;
    importance: number;
    ebbinghaus: number;
    final: number;
  };
}

interface RecallResponse {
  results: RecallResult[];
  metadata: {
    query: string;
    total: number;
    latencyMs: number;
  };
}

/**
 * Main recall search with hybrid scoring
 */
export async function recallSearch(params: RecallSearchParams): Promise<RecallResponse> {
  const startTime = Date.now();
  const qdrant = getQdrantClient();
  const embedService = getMistralEmbedService();

  const {
    userId,
    query,
    limit = 10,
    memoryTypes,
    sourcePlatform,
    minImportance,
    recencyBias = 0.5,
    timeDecayHalfLife = 30,
  } = params;

  logger.info('Recall search', {
    userId,
    queryLength: query.length,
    limit,
    recencyBias,
  });

  // Generate query embedding
  const { embedding } = await embedService.embed(query);

  // Build filter
  const filter: any = {
    must: [
      { key: 'user_id', match: { value: userId } },
      { key: 'is_latest', match: { value: true } },
    ],
  };

  if (memoryTypes && memoryTypes.length > 0) {
    filter.must.push({
      key: 'memory_type',
      match: { any: memoryTypes },
    });
  }

  if (sourcePlatform) {
    filter.must.push({
      key: 'source_platform',
      match: { value: sourcePlatform },
    });
  }

  if (minImportance !== undefined) {
    filter.must.push({
      key: 'importance_score',
      range: { gte: minImportance },
    });
  }

  // Search Qdrant
  const vectorResults = await qdrant.search({
    collection: 'hivemind_memories',
    vector: embedding,
    filter,
    limit: limit * 2, // Get more for re-ranking
    withPayload: true,
  });

  if (vectorResults.length === 0) {
    return {
      results: [],
      metadata: {
        query,
        total: 0,
        latencyMs: Date.now() - startTime,
      },
    };
  }

  // Fetch full memory data from PostgreSQL
  const memoryIds = vectorResults.map(r => r.id);
  const memories = await prisma.memory.findMany({
    where: {
      id: { in: memoryIds },
      userId,
      deletedAt: null,
    },
  });

  // Create memory map
  const memoryMap = new Map(memories.map(m => [m.id, m]));

  // Calculate hybrid scores
  const scoredResults: RecallResult[] = vectorResults
    .map(result => {
      const memory = memoryMap.get(result.id);
      if (!memory) return null;

      const vectorScore = result.score;
      const recencyScore = calculateRecencyScore(
        memory.documentDate,
        recencyBias,
        timeDecayHalfLife
      );
      const importanceScore = memory.importanceScore;
      const ebbinghausScore = calculateEbbinghausScore(
        memory.strength,
        memory.recallCount,
        memory.lastConfirmedAt
      );

      // Weighted final score
      const finalScore =
        vectorScore * 0.4 +
        recencyScore * recencyBias * 0.3 +
        importanceScore * 0.2 +
        ebbinghausScore * (1 - recencyBias) * 0.1;

      return {
        id: memory.id,
        content: memory.content,
        memoryType: memory.memoryType,
        title: memory.title,
        tags: memory.tags,
        sourcePlatform: memory.sourcePlatform,
        documentDate: memory.documentDate,
        importanceScore: memory.importanceScore,
        scores: {
          vector: vectorScore,
          recency: recencyScore,
          importance: importanceScore,
          ebbinghaus: ebbinghausScore,
          final: finalScore,
        },
      };
    })
    .filter((r): r is RecallResult => r !== null);

  // Sort by final score
  scoredResults.sort((a, b) => b.scores.final - a.scores.final);

  // Limit results
  const topResults = scoredResults.slice(0, limit);

  logger.info('Recall search completed', {
    resultsCount: topResults.length,
    latencyMs: Date.now() - startTime,
  });

  return {
    results: topResults,
    metadata: {
      query,
      total: topResults.length,
      latencyMs: Date.now() - startTime,
    },
  };
}

/**
 * Calculate recency score with exponential decay
 */
function calculateRecencyScore(
  documentDate: Date,
  bias: number,
  halfLifeDays: number
): number {
  const now = new Date();
  const daysSince = (now.getTime() - documentDate.getTime()) / (1000 * 60 * 60 * 24);

  // Exponential decay: score = 2^(-days/halfLife)
  const decay = Math.pow(2, -daysSince / halfLifeDays);

  // Apply bias: higher bias = more weight on recency
  return decay * bias + (1 - bias) * 0.5;
}

/**
 * Calculate Ebbinghaus forgetting curve score
 * Based on: R = e^(-t/S) where S is strength
 */
function calculateEbbinghausScore(
  strength: number,
  recallCount: number,
  lastConfirmedAt: Date
): number {
  const now = new Date();
  const daysSince = (now.getTime() - lastConfirmedAt.getTime()) / (1000 * 60 * 60 * 24);

  // Ebbinghaus formula with strength modifier
  // Higher strength = slower forgetting
  const decayRate = 1 / (strength * 10);
  const retention = Math.exp(-daysSince * decayRate);

  // Boost from repeated recalls
  const recallBoost = Math.min(0.3, recallCount * 0.05);

  return Math.min(1.0, retention + recallBoost);
}

/**
 * Get conversation context (recent + relevant memories)
 */
export async function getConversationContext(params: {
  userId: string;
  topic?: string;
  limit?: number;
}): Promise<{ memories: RecallResult[] }> {
  const { userId, topic, limit = 20 } = params;

  if (topic) {
    // Search by topic
    const results = await recallSearch({
      userId,
      query: topic,
      limit,
      recencyBias: 0.3, // Less recency bias for context
    });
    return { memories: results.results };
  }

  // Default: get recent high-importance memories
  const memories = await prisma.memory.findMany({
    where: {
      userId,
      isLatest: true,
      deletedAt: null,
    },
    orderBy: [
      { importanceScore: 'desc' },
      { documentDate: 'desc' },
    ],
    take: limit,
  });

  return {
    memories: memories.map(m => ({
      id: m.id,
      content: m.content,
      memoryType: m.memoryType,
      title: m.title,
      tags: m.tags,
      sourcePlatform: m.sourcePlatform,
      documentDate: m.documentDate,
      importanceScore: m.importanceScore,
      scores: {
        vector: 1.0,
        recency: 1.0,
        importance: m.importanceScore,
        ebbinghaus: 1.0,
        final: 1.0,
      },
    })),
  };
}

export default { recallSearch, getConversationContext };
```

---

## 4. Ebbinghaus Decay Optimization

### 4.1 Memory Strength Service

```typescript
// File: ml/recall/ebbinghaus.service.ts

import { PrismaClient } from '@prisma/client';
import { logger } from '../../utils/logger';

const prisma = new PrismaClient();

interface EbbinghausConfig {
  initialStrength: number;
  decayRate: number;
  recallBoost: number;
  maxStrength: number;
  halfLifeDays: number;
}

const DEFAULT_CONFIG: EbbinghausConfig = {
  initialStrength: 1.0,
  decayRate: 0.1,
  recallBoost: 0.15,
  maxStrength: 10.0,
  halfLifeDays: 7,
};

/**
 * Update memory strength based on Ebbinghaus forgetting curve
 */
export async function updateMemoryStrength(params: {
  memoryId: string;
  action: 'recall' | 'confirm' | 'ignore';
}): Promise<void> {
  const { memoryId, action } = params;

  try {
    const memory = await prisma.memory.findUnique({
      where: { id: memoryId },
    });

    if (!memory) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    let newStrength = memory.strength;
    let newRecallCount = memory.recallCount;
    let newLastConfirmedAt = memory.lastConfirmedAt;

    switch (action) {
      case 'recall':
        // Memory was recalled - boost strength
        newStrength = Math.min(
          DEFAULT_CONFIG.maxStrength,
          memory.strength + DEFAULT_CONFIG.recallBoost
        );
        newRecallCount = memory.recallCount + 1;
        newLastConfirmedAt = new Date();
        break;

      case 'confirm':
        // User confirmed memory is still valid - larger boost
        newStrength = Math.min(
          DEFAULT_CONFIG.maxStrength,
          memory.strength + DEFAULT_CONFIG.recallBoost * 2
        );
        newRecallCount = memory.recallCount + 1;
        newLastConfirmedAt = new Date();
        break;

      case 'ignore':
        // Memory was shown but not used - slight decay
        newStrength = Math.max(
          0.1,
          memory.strength * (1 - DEFAULT_CONFIG.decayRate * 0.5)
        );
        break;
    }

    // Apply time-based decay
    const daysSinceLastConfirm =
      (Date.now() - newLastConfirmedAt.getTime()) / (1000 * 60 * 60 * 24);
    const timeDecay = Math.exp(-daysSinceLastConfirm / DEFAULT_CONFIG.halfLifeDays);
    newStrength *= timeDecay;

    // Update database
    await prisma.memory.update({
      where: { id: memoryId },
      data: {
        strength: newStrength,
        recallCount: newRecallCount,
        lastConfirmedAt: newLastConfirmedAt,
      },
    });

    logger.debug('Memory strength updated', {
      memoryId,
      action,
      newStrength,
      recallCount: newRecallCount,
    });
  } catch (error) {
    logger.error('Memory strength update failed', { memoryId, action, error });
    throw error;
  }
}

/**
 * Batch update strengths for all memories (daily job)
 */
export async function applyDailyDecay(): Promise<void> {
  try {
    const memories = await prisma.memory.findMany({
      where: {
        isLatest: true,
        deletedAt: null,
      },
    });

    const updates: Array<Promise<any>> = [];

    for (const memory of memories) {
      const daysSinceLastConfirm =
        (Date.now() - memory.lastConfirmedAt.getTime()) / (1000 * 60 * 60 * 24);

      // Apply decay
      const decay = Math.exp(-daysSinceLastConfirm / DEFAULT_CONFIG.halfLifeDays);
      const newStrength = Math.max(0.1, memory.strength * decay);

      if (Math.abs(newStrength - memory.strength) > 0.01) {
        updates.push(
          prisma.memory.update({
            where: { id: memory.id },
            data: { strength: newStrength },
          })
        );
      }
    }

    if (updates.length > 0) {
      await Promise.all(updates);
      logger.info('Daily decay applied', { memoriesUpdated: updates.length });
    }
  } catch (error) {
    logger.error('Daily decay failed', { error });
  }
}

/**
 * Get memories needing reinforcement (low strength)
 */
export async function getMemoriesNeedingReinforcement(params: {
  userId: string;
  maxStrength?: number;
  limit?: number;
}): Promise<any[]> {
  const { userId, maxStrength = 0.5, limit = 10 } = params;

  const memories = await prisma.memory.findMany({
    where: {
      userId,
      isLatest: true,
      deletedAt: null,
      strength: { lt: maxStrength },
    },
    orderBy: { strength: 'asc' },
    take: limit,
  });

  return memories;
}

export default { updateMemoryStrength, applyDailyDecay, getMemoriesNeedingReinforcement };
```

---

## 5. A/B Testing Framework

### 5.1 A/B Test Service

```typescript
// File: ml/ab-testing/ab-test.service.ts

import { PrismaClient } from '@prisma/client';
import { logger } from '../../core/src/utils/logger';
import crypto from 'crypto';

const prisma = new PrismaClient();

interface ABTestConfig {
  name: string;
  description: string;
  variants: {
    id: string;
    name: string;
    weight: number; // 0-1, sum should be 1
    config: Record<string, any>;
  }[];
  startDate: Date;
  endDate?: Date;
  targetMetric: 'click_through' | 'dwell_time' | 'user_rating' | 'recall_precision';
}

interface ABTestAssignment {
  testId: string;
  userId: string;
  variantId: string;
  assignedAt: Date;
}

/**
 * Create A/B test
 */
export async function createABTest(config: ABTestConfig): Promise<string> {
  const test = await prisma.dataExportRequest.create({
    // Using existing table as placeholder
    data: {
      userId: 'system',
      requestType: 'export',
      status: 'pending',
    },
  });

  // In production: Create proper A/B test table
  logger.info('A/B test created', { name: config.name });

  return test.id;
}

/**
 * Assign user to variant
 */
export async function assignVariant(testId: string, userId: string): Promise<string> {
  // Check for existing assignment
  const existing = await getAssignment(testId, userId);
  if (existing) {
    return existing.variantId;
  }

  // Get test config
  const test = await getTestConfig(testId);

  // Deterministic assignment based on user ID hash
  const hash = crypto.createHash('sha256');
  hash.update(`${testId}:${userId}`);
  const hashValue = parseInt(hash.digest('hex').substring(0, 8), 16);
  const normalizedHash = hashValue / 0xffffffff;

  // Assign based on weights
  let cumulativeWeight = 0;
  let assignedVariant = test.variants[0].id;

  for (const variant of test.variants) {
    cumulativeWeight += variant.weight;
    if (normalizedHash < cumulativeWeight) {
      assignedVariant = variant.id;
      break;
    }
  }

  // Store assignment
  await storeAssignment(testId, userId, assignedVariant);

  logger.info('User assigned to variant', {
    testId,
    userId,
    variantId: assignedVariant,
  });

  return assignedVariant;
}

/**
 * Get variant config for user
 */
export async function getVariantConfig(testId: string, userId: string): Promise<Record<string, any>> {
  const variantId = await assignVariant(testId, userId);
  const test = await getTestConfig(testId);

  const variant = test.variants.find(v => v.id === variantId);
  return variant?.config || {};
}

/**
 * Record metric for A/B test
 */
export async function recordMetric(params: {
  testId: string;
  userId: string;
  variantId: string;
  metric: string;
  value: number;
  metadata?: Record<string, any>;
}): Promise<void> {
  // In production: Store in dedicated metrics table
  logger.debug('A/B test metric recorded', params);
}

/**
 * Analyze A/B test results
 */
export async function analyzeABTest(testId: string): Promise<any> {
  // In production: Query metrics table and calculate statistical significance
  const test = await getTestConfig(testId);

  return {
    testId,
    name: test.name,
    variants: test.variants.map(v => ({
      variantId: v.id,
      name: v.name,
      assignments: 0, // Would query from DB
      metrics: {}, // Would aggregate from metrics
    })),
  };
}

// Placeholder functions - implement with proper tables
async function getAssignment(testId: string, userId: string): Promise<ABTestAssignment | null> {
  return null;
}

async function storeAssignment(testId: string, userId: string, variantId: string): Promise<void> {
  // Store in DB
}

async function getTestConfig(testId: string): Promise<ABTestConfig> {
  // Return test config
  return {
    name: 'Test',
    description: 'Test',
    variants: [],
    startDate: new Date(),
    targetMetric: 'recall_precision',
  };
}

export default { createABTest, assignVariant, getVariantConfig, recordMetric, analyzeABTest };
```

### 5.2 Recall Quality Metrics

```typescript
// File: ml/ab-testing/recall-metrics.ts

interface RecallMetrics {
  precision: number;
  recall: number;
  ndcg: number;
  mrr: number;
}

/**
 * Calculate NDCG (Normalized Discounted Cumulative Gain)
 */
export function calculateNDCG(rankings: number[], idealRankings: number[]): number {
  const dcg = rankings.reduce((sum, rel, i) => {
    return sum + rel / Math.log2(i + 2);
  }, 0);

  const idealDcg = idealRankings.reduce((sum, rel, i) => {
    return sum + rel / Math.log2(i + 2);
  }, 0);

  return idealDcg > 0 ? dcg / idealDcg : 0;
}

/**
 * Calculate MRR (Mean Reciprocal Rank)
 */
export function calculateMRR(rankings: boolean[]): number {
  const firstRelevant = rankings.findIndex(r => r);
  return firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0;
}

/**
 * Track user feedback on recall results
 */
export async function trackRecallFeedback(params: {
  userId: string;
  query: string;
  results: string[]; // Memory IDs
  clickedId?: string;
  dwellTimes?: Record<string, number>; // ms per memory
  rating?: number; // 1-5
}): Promise<void> {
  logger.info('Recall feedback tracked', {
    userId: params.userId,
    queryLength: params.query.length,
    resultsCount: params.results.length,
    clicked: !!params.clickedId,
    rating: params.rating,
  });

  // Store feedback for analysis
}

export default { calculateNDCG, calculateMRR, trackRecallFeedback };
```

---

## 6. Acceptance Criteria

### 6.1 Functional Requirements

| ID | Requirement | Test Method | Pass Criteria |
|----|-------------|-------------|---------------|
| ML-01 | Qdrant collections created | Check collections | 2 collections exist |
| ML-02 | Mistral-embed generates vectors | Embed test text | 1024-dim vector |
| ML-03 | Vector search returns results | Search test query | Results with scores |
| ML-04 | User isolation enforced | Cross-user search | No cross-user results |
| ML-05 | Recall scoring works | Check scores | All score components present |
| ML-06 | Ebbinghaus decay applies | Check strength over time | Strength decreases |
| ML-07 | Embedding cache works | Embed same text twice | Second is faster |
| ML-08 | A/B test assigns variants | Assign users | Consistent assignment |

### 6.2 Performance Requirements

| Metric | Target | Measurement |
|--------|--------|-------------|
| Embedding latency | P99 <500ms | Single text |
| Batch embedding | P99 <5s | 100 texts |
| Vector search | P99 <100ms | With filters |
| Recall scoring | P99 <200ms | Full pipeline |
| Cache hit rate | >80% | Same texts |

### 6.3 Quality Requirements

| Metric | Target | Measurement |
|--------|--------|-------------|
| Recall precision@10 | >0.7 | Human evaluation |
| NDCG@10 | >0.8 | A/B test |
| MRR | >0.6 | A/B test |

---

## 7. Testing Instructions

### 7.1 Unit Tests

```bash
# Run ML tests
npm run test:ml

# Test embeddings
npm run test:ml -- embeddings.test.ts

# Test recall
npm run test:ml -- recall.test.ts
```

### 7.2 Integration Tests

```bash
# Start Qdrant
docker run -d -p 6333:6333 qdrant/qdrant

# Run integration tests
npm run test:integration -- ml/
```

### 7.3 Load Tests

```bash
# Test embedding throughput
k6 run tests/load/embeddings.js

# Test recall search
k6 run tests/load/recall-search.js
```

---

## 8. Environment Variables

```bash
# Qdrant
QDRANT_URL=https://hivemind-fr-par-1.cloud.qdrant.io
QDRANT_API_KEY=your-api-key

# Mistral
MISTRAL_API_KEY=your-mistral-key
MISTRAL_MODEL=mistral-embed

# Embedding cache
EMBEDDING_CACHE_TTL=86400
EMBEDDING_CACHE_MAX_SIZE=100000

# Recall scoring
RECALL_VECTOR_WEIGHT=0.4
RECALL_RECENCY_WEIGHT=0.3
RECALL_IMPORTANCE_WEIGHT=0.2
RECALL_EBBINGHAUS_WEIGHT=0.1
EBBINGHAUS_HALF_LIFE_DAYS=7
```

---

## 9. References

- [CROSS_PLATFORM_SYNC_SPEC.md](../CROSS_PLATFORM_SYNC_SPEC.md)
- [Qdrant Documentation](https://qdrant.tech/documentation/)
- [Mistral AI API](https://docs.mistral.ai/api/)
- [Ebbinghaus Forgetting Curve](https://en.wikipedia.org/wiki/Forgetting_curve)
- [NDCG Metric](https://en.wikipedia.org/wiki/Discounted_cumulative_gain)

---

**Document Approval:**

| Role | Name | Date | Signature |
|------|------|------|-----------|
| ML Lead | | | |
| Backend Lead | | | |
| Security Engineer | | | |

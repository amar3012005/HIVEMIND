const crypto = require('crypto');
const { classifyRelationships } = require('./relationship-classifier');
const { createPersistedMemoryWriter } = require('./persistence');

class InMemoryVectorStore {
  constructor() {
    this.collections = new Map();
  }

  ensureCollection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, []);
    }
    return this.collections.get(name);
  }

  async upsert(collectionName, points) {
    const collection = this.ensureCollection(collectionName);
    collection.push(...points);
    return { upserted: points.length };
  }

  async search(collectionName, _vector, topK = 5) {
    const collection = this.ensureCollection(collectionName);
    return collection.slice(-topK).map((point) => ({ id: point.id, payload: point.payload }));
  }
}

class QdrantVectorStore {
  constructor(options = {}) {
    this.url = options.url || process.env.QDRANT_URL;
    this.apiKey = options.apiKey || process.env.QDRANT_API_KEY;
    this.dimension = Number(options.dimension || process.env.EMBEDDING_DIMENSION || 1536);
    this.readyCollections = new Set();
  }

  async ensureCollection(name) {
    if (!this.url || this.readyCollections.has(name)) {
      return;
    }

    const response = await fetch(`${this.url}/collections/${name}`, {
      headers: this.apiKey ? { 'api-key': this.apiKey } : {},
    });

    if (response.ok) {
      this.readyCollections.add(name);
      return;
    }

    const createResponse = await fetch(`${this.url}/collections/${name}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
      },
      body: JSON.stringify({
        vectors: {
          size: this.dimension,
          distance: 'Cosine',
        },
      }),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      throw new Error(`Qdrant collection ensure failed: ${errorText}`);
    }

    this.readyCollections.add(name);
  }

  async upsert(collectionName, points) {
    await this.ensureCollection(collectionName);
    const response = await fetch(`${this.url}/collections/${collectionName}/points?wait=true`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
      },
      body: JSON.stringify({ points }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Qdrant upsert failed: ${errorText}`);
    }

    return { upserted: points.length };
  }

  async search(collectionName, vector, topK = 5) {
    await this.ensureCollection(collectionName);
    const response = await fetch(`${this.url}/collections/${collectionName}/points/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
      },
      body: JSON.stringify({
        vector,
        limit: topK,
        with_payload: true,
      }),
    });

    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    return payload.result || [];
  }
}

// Tenant-scoped collection naming for multi-tenant isolation + per-tenant
// Qdrant index size control. Org takes precedence (enterprise tenant), user
// is the personal scope. Falls back to legacy QDRANT_COLLECTION env so
// existing data + collection-not-found Qdrant 404s stay backward-compatible
// until a migration sweeps old data into per-org collections.
function buildCollectionName(userId, orgId) {
  if (process.env.QDRANT_PER_TENANT === 'true') {
    if (orgId) return `org_${orgId}`;
    if (userId) return `user_${userId}`;
  }
  return 'HIVEMIND_PERSONAL';
}

function contentHashPointId(content, scopeKey) {
  const h = crypto.createHash('sha256');
  h.update(String(scopeKey || ''));
  h.update('\0');
  h.update(String(content || ''));
  // Qdrant accepts UUID-string or u64 ids. Use UUID v5-shape (32 hex → uuid format).
  const hex = h.digest('hex').slice(0, 32);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

function createDefaultVectorStore() {
  if (process.env.QDRANT_URL) {
    return new QdrantVectorStore();
  }

  return new InMemoryVectorStore();
}

async function indexEmbeddedChunks(chunks, context = {}, deps = {}) {
  const vectorStore = deps.vectorStore || createDefaultVectorStore();
  const memoryWriter = deps.memoryWriter || await createPersistedMemoryWriter();
  const relationships = [];
  const collectionName = buildCollectionName(context.user_id, context.org_id);
  const memoryIds = [];
  // Per-tenant scope so the same chunk content for different orgs/users
  // gets distinct point IDs (no cross-tenant collision).
  const scopeKey = context.org_id || context.user_id || 'global';

  const points = [];

  for (const chunk of chunks) {
    // Content-hash point ID gives free dedup on re-upload: same content +
    // same tenant => same UUID => Qdrant upsert overwrites in place.
    let pointId = contentHashPointId(chunk.content, scopeKey);
    let edgesCreated = 0;

    if (memoryWriter) {
      const persisted = await memoryWriter.persistChunk(chunk, context);
      pointId = persisted.memory.id;
      memoryIds.push(persisted.memory.id);
      edgesCreated += persisted.edges_created;
    }

    const payload = {
      memory_id: pointId,
      user_id: context.user_id,
      org_id: context.org_id,
      project: context.project || null,
      source_type: context.source_type,
      scope_chain: chunk.scope_chain || 'global',
      page_number: chunk.metadata?.page_number || 1,
      language: context.language || 'text',
      pii_flagged: chunk.pii_flagged || false,
    };

    points.push({
      id: pointId,
      vector: chunk.embedding,
      payload,
    });

    if (!memoryWriter) {
      const candidates = await vectorStore.search(collectionName, chunk.embedding, 5);
      const classified = await classifyRelationships({
        chunk,
        candidates,
        classifier: deps.relationshipClassifier,
      });

      relationships.push(...classified.map((edge) => ({
        from_id: pointId,
        ...edge,
      })));
    } else {
      relationships.push({ from_id: pointId, type: 'persisted', score: edgesCreated });
    }
  }

  await vectorStore.upsert(collectionName, points);

  return {
    indexed_count: points.length,
    edges_created: memoryWriter
      ? relationships.reduce((sum, relationship) => sum + (relationship.score || 0), 0)
      : relationships.length,
    collection_name: collectionName,
    relationships,
    memory_ids: memoryIds,
    vectorStore,
  };
}

module.exports = {
  indexEmbeddedChunks,
  InMemoryVectorStore,
  QdrantVectorStore,
  buildCollectionName,
};

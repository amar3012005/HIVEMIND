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
    this.dimension = Number(options.dimension || 1536);
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

function buildCollectionName(userId) {
  return `hivemind_${userId}`;
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
  const collectionName = buildCollectionName(context.user_id);
  const memoryIds = [];

  const points = [];

  for (const chunk of chunks) {
    let pointId = `${context.request_id}:${chunk.chunk_index}`;
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

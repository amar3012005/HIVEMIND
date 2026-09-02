/**
 * Engine Box composition factory.
 *
 * This is intentionally separate from server.js: it owns only the local
 * document-first pipeline and never creates hosted workflow, credit, connector,
 * or remote-organisation clients.  The worker and the local API both consume
 * this factory so an upload cannot take a different path depending on entrypoint.
 */
import { DocumentFirstIngestionService } from '../knowledge/document-first-ingestion.js';
import { parseWithHmExtract } from '../knowledge/enterprise/hm-extract-adapter.js';
import { IngestTracker } from '../memory/ingest-tracker.js';
import { MemoryGraphEngine } from '../memory/graph-engine.js';
import { PrismaGraphStore } from '../memory/prisma-graph-store.js';
import { SmartIngestRouter } from '../memory/smart-ingest-router.js';
import { getLocalPrismaClient } from './local-prisma.mjs';

function qdrantHeaders() { return { 'content-type': 'application/json' }; }

function qdrantName(orgId) {
  // The organisation value is UUID-shaped after local OIDC/RBAC admission;
  // keep the collection name constrained even if a bad request reaches here.
  return `engine_${String(orgId || 'default').replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** Local hm-extract has the parser adapter shape expected by the canonical DFI. */
export function createHmExtractAdapter({ parse = parseWithHmExtract } = {}) {
  return {
    async parseBuffer(buffer, { filename }) {
      const result = await parse(buffer, filename);
      if (!result?.ok) return { error: result?.error || 'hm-extract returned no result', engine: 'hm-extract' };
      return {
        text: result.text || result.markdown || '',
        markdown: result.markdown || null,
        json: null,
        tables: [],
        pages: result.meta?.pages ? Array.from({ length: result.meta.pages }, (_, index) => ({ page: index + 1 })) : [],
        confidence: null,
        hybridChunks: [],
        engine: result.tier || 'hm-extract',
      };
    },
  };
}

/**
 * Minimal Qdrant/model-router implementation for the canonical DFI embedding
 * contract.  The model router is the only process allowed to see model secrets.
 */
export function createLocalEmbeddingService({ qdrantUrl, modelRouterUrl, dimension, fetchImpl = fetch } = {}) {
  const vectorDimension = Number(dimension || process.env.ENGINE_BOX_EMBEDDING_DIMENSION || 1024);
  if (!Number.isInteger(vectorDimension) || vectorDimension < 1) throw new Error('ENGINE_BOX_EMBEDDING_DIMENSION must be a positive integer');
  const router = String(modelRouterUrl || process.env.MODEL_ROUTER_URL || 'http://hm-model-router:8090').replace(/\/$/, '');
  const qdrant = String(qdrantUrl || process.env.QDRANT_URL || 'http://qdrant:6333').replace(/\/$/, '');

  async function requireOk(response, label) {
    if (!response.ok) throw new Error(`${label} returned ${response.status}: ${await response.text()}`);
    return response;
  }
  return {
    collectionForOrg: qdrantName,
    async embed(input) {
      const values = Array.isArray(input) ? input : [input];
      const response = await requireOk(await fetchImpl(`${router}/v1/infer`, {
        method: 'POST', headers: qdrantHeaders(),
        body: JSON.stringify({ capability: 'embedding', input: values.map(String) }),
      }), 'local embedding router');
      const body = await response.json();
      if (!Array.isArray(body?.vectors) || body.vectors.length !== values.length
        || body.vectors.some((vector) => !Array.isArray(vector) || vector.length !== vectorDimension)) {
        throw new Error('local embedding router returned vectors incompatible with the configured dimension');
      }
      return Array.isArray(input) ? body.vectors : body.vectors[0];
    },
    async ensureCollection(collectionName) {
      const existing = await fetchImpl(`${qdrant}/collections/${encodeURIComponent(collectionName)}`, { headers: qdrantHeaders() });
      if (existing.ok) return true;
      if (existing.status !== 404) await requireOk(existing, 'Qdrant collection lookup');
      await requireOk(await fetchImpl(`${qdrant}/collections/${encodeURIComponent(collectionName)}`, {
        method: 'PUT', headers: qdrantHeaders(),
        body: JSON.stringify({ vectors: { size: vectorDimension, distance: 'Cosine' } }),
      }), 'Qdrant collection creation');
      return true;
    },
    async storeVectors({ collectionName, points }) {
      await requireOk(await fetchImpl(`${qdrant}/collections/${encodeURIComponent(collectionName)}/points?wait=true`, {
        method: 'PUT', headers: qdrantHeaders(), body: JSON.stringify({ points }),
      }), 'Qdrant vector upsert');
    },
    async storeVector({ collectionName, id, vector, payload }) {
      return this.storeVectors({ collectionName, points: [{ id, vector, payload }] });
    },
  };
}

/** Build the durable local graph + canonical document-first ingestion runtime. */
export function createLocalEngineRuntime({ env = process.env, prisma = null, embeddingService = null, parserAdapter = null, logger = console } = {}) {
  const db = prisma || getLocalPrismaClient(env);
  const graphStore = new PrismaGraphStore(db);
  const smartIngestRouter = new SmartIngestRouter({ memoryStore: graphStore });
  const memoryGraphEngine = new MemoryGraphEngine({ store: graphStore, smartIngestRouter });
  const embeddings = embeddingService || createLocalEmbeddingService({
    qdrantUrl: env.QDRANT_URL,
    modelRouterUrl: env.MODEL_ROUTER_URL,
    dimension: env.ENGINE_BOX_EMBEDDING_DIMENSION,
  });
  const documentFirstIngestion = new DocumentFirstIngestionService({
    db,
    smartIngestRouter,
    memoryGraphEngine,
    doclingAdapter: parserAdapter || createHmExtractAdapter(),
    embeddingService: embeddings,
    collectionResolver: embeddings.collectionForOrg,
    logger,
  });
  return {
    db,
    graphStore,
    smartIngestRouter,
    memoryGraphEngine,
    embeddingService: embeddings,
    documentFirstIngestion,
    ingestTracker: new IngestTracker(),
  };
}

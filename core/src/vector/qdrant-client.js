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
// mneme (.amr) per-org shadow backend — inert unless MNEME_ENABLED_ORGS lists the org.
import { mnemeOn, mirrorStore, mirrorDelete, search as mnemeSearch } from './mneme-backend.js';
import { amrRecall, amrWrite, isMnemeOrg, orgIsRemote, memoryBackend } from './mneme/driver.js';
import { qdrantUrlFor } from './mneme/remote-backend.js';
import { currentOrg } from '../db/prisma.js';
import { resolveCollectionForOrg, PER_TENANT } from './container-router.js';
import { currentStageSignal } from '../runtime/stage-deadline.js';
import { assertTenantOrg, enforceTenantFilter } from './tenant-filter.js';
import {
  isTrackableManagedMemory,
  markVectorFailed,
  markVectorPending,
  markVectorSynced,
} from './managed-vector-ledger.js';
import { isValidEmbeddingVector } from '../embeddings/vector-contract.js';

// Per-org Qdrant base: the customer's Qdrant (via tunnel) for a self-host-hybrid org, else central.
const qbase = () => qdrantUrlFor(currentOrg()) || QDRANT_URL;

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
// int8 quant rescore — re-rank quantized ANN candidates against full-precision
// vectors at search time. ACCURATE but reads full-precision vectors from
// on_disk storage: at pool 150 × oversampling 2 = 300 disk reads/search ≈ 4s.
// Default OFF (the adversarial's call — eval-gate on a ≥200k corpus before
// enabling); QDRANT_QUANT_RESCORE=true to turn on per deployment.
const QUANT_RESCORE = process.env.QDRANT_QUANT_RESCORE === 'true';
const QUANT_OVERSAMPLING = Number(process.env.QDRANT_QUANT_OVERSAMPLING || 1.5);

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

export function buildHybridSearchFilter(filters = {}) {
  const must = [];
  if (filters.user_id) must.push({ key: 'user_id', match: { value: filters.user_id } });
  if (filters.org_id) must.push({ key: 'org_id', match: { value: filters.org_id } });
  if (filters.project) must.push({ key: 'project', match: { value: filters.project } });
  if (Array.isArray(filters.project_ids) && filters.project_ids.length > 0) {
    must.push({ key: 'project_ids', match: { any: filters.project_ids } });
  } else if (typeof filters.project_id === 'string' && filters.project_id.trim()) {
    must.push({ key: 'project_ids', match: { any: [filters.project_id.trim()] } });
  }
  if (typeof filters.team_id === 'string' && filters.team_id.trim()) {
    must.push({ key: 'team_id', match: { value: filters.team_id.trim() } });
  }
  if (Array.isArray(filters.tags) && filters.tags.length > 0) {
    must.push({ key: 'tags', match: { any: filters.tags } });
  }
  if (filters.is_latest !== undefined) {
    must.push({ key: 'is_latest', match: { value: filters.is_latest } });
  }
  if (filters.known_at) must.push({ key: 'created_at', range: { lte: filters.known_at } });
  if (filters.valid_at) {
    must.push({
      should: [
        { is_empty: { key: 'valid_from' } },
        { key: 'valid_from', range: { lte: filters.valid_at } },
      ],
    });
    must.push({
      should: [
        { is_empty: { key: 'valid_to' } },
        { key: 'valid_to', range: { gt: filters.valid_at } },
      ],
    });
  }
  return must.length > 0 ? { must } : undefined;
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
    this.connectedCheckedAt = 0;
    // Per-process set of collections whose payload indexes have already been
    // ensured. MUST be a Set, not a single value: this is a MULTI-TENANT
    // server that alternates between org_<id>, HIVEMIND_PERSONAL, and other
    // containers every few requests. A scalar `collectionReady` was
    // invalidated on every tenant switch, so EVERY query re-ran
    // ensureMemoriesCollectionIndexes → createPayloadIndex(wait:true) × N
    // fields — blocking Qdrant round-trips that dominated chat latency
    // (observed 26–60s, growing as calls alternated tenants). A Set makes it
    // once-per-collection-per-process, moving schema setup off the query path.
    this.collectionReady = new Set();
    this._litellmReady = null;
  }

  async ensureCollection(collectionName = this.collectionName) {
    if (this.collectionReady.has(collectionName)) {
      return true;
    }

    try {
      const resolvedCollectionName = resolveCollectionName(collectionName);
      const response = await fetch(`${qbase()}/collections/${resolvedCollectionName}`, {
        headers,
        signal: currentStageSignal() || undefined,
      });
      // getQdrantCollections takes positional args (url, apiKey, region) —
      // passing an object made `url` itself an object, blowing up later
      // with `url.startsWith is not a function`.
      const collections = getQdrantCollections(qbase(), API_KEY);

      if (response.ok) {
        await collections.ensureMemoriesCollectionIndexes(resolvedCollectionName);
        this.collectionReady.add(collectionName);
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
      this.collectionReady.add(collectionName);
      return true;
    } catch (error) {
      if (currentStageSignal()?.aborted) throw error;
      console.error('Failed to ensure Qdrant collection:', error.message);
      return false;
    }
  }

  /**
   * Check if Qdrant is available
   * @returns {Promise<boolean>} Connection status
   */
  async isConnected() {
    const negativeTtlMs = Math.max(100, Number(process.env.QDRANT_NEGATIVE_HEALTH_TTL_MS || 2_000));
    if (this.connected === true) {
      return this.connected;
    }
    if (this.connected === false && Date.now() - this.connectedCheckedAt < negativeTtlMs) return false;
    const connected = await this.testConnection();
    // A request-scoped cancellation is not a Qdrant health verdict. The
    // cancelled probe throws below and therefore never poisons this process-
    // wide cache with `false` for every tenant that follows.
    this.connected = connected;
    this.connectedCheckedAt = Date.now();
    return connected;
  }

  /**
   * Generate embedding for text
   * @param {string} text - Text to embed
   * @returns {Promise<number[]>} Configured embedding vector
   */
  async generateEmbedding(text, options = {}) {
    // Wait for async LiteLLM init if needed
    if (this._litellmReady) await this._litellmReady;

    if (!this.embedService) {
      console.warn('⚠️  Embedding service not available');
      return null;
    }

    try {
      return await this.embedService.embedOne(text, options);
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
  async generateEmbeddings(texts, options = {}) {
    if (this._litellmReady) await this._litellmReady;
    if (!this.embedService || !Array.isArray(texts) || texts.length === 0) return [];
    return this.embedService.embed(texts, options);
  }

  /**
   * Store memory with vector embedding
   * @param {object} memory - Memory object with content and metadata
   * @returns {Promise<string>} Memory ID
   */
  async storeMemory(memory, options = {}) {
    assertTenantOrg(memory.org_id, currentOrg());
    const collectionName = await routeCollection({ explicit: options.collectionName, orgId: memory.org_id });
    const layer = options.layer || memory.layer || (memory.cognitive_layer_role ? 'cognitive' : 'memory');
    const trackManaged = isTrackableManagedMemory(memory, {
      layer,
      remote: orgIsRemote(memory.org_id),
      personal: isMnemeOrg(memory.org_id),
    });
    const ledgerPending = trackManaged ? await markVectorPending(memory, collectionName) : false;

    // Check connection first
    const connected = await this.isConnected();
    if (!connected) {
      console.warn('⚠️  Qdrant unavailable; authoritative row remains pending for reconciliation');
      if (trackManaged) await markVectorFailed(memory.id, 'qdrant_unavailable');
      return null;
    }

    const collectionReady = await this.ensureCollection(collectionName);
    if (!collectionReady) {
      console.warn('⚠️  Qdrant collection unavailable; authoritative row remains pending for reconciliation');
      if (trackManaged) await markVectorFailed(memory.id, 'qdrant_collection_unavailable');
      return null;
    }

    // Reuse precomputed embedding when supplied (knowledge upload pipeline
    // pre-embeds chunks in parallel before smart ingest to avoid re-embedding).
    let embedding = options.vector || null;

    if (!isValidEmbeddingVector(embedding)) {
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
      const embeddingOptions = {
        workload: options.embeddingWorkload || 'interactive',
        tenantId: memory.org_id,
        signal: options.signal,
      };
      embedding = await this.generateEmbedding(embeddingInput, embeddingOptions);
      // Retry transient embed-service blips before giving up — a memory with no
      // real vector is invisible to semantic recall (the drift bug).
      for (let _r = 0; _r < 2 && !isValidEmbeddingVector(embedding); _r++) {
        await new Promise((r) => setTimeout(r, 300 * (_r + 1)));
        try { embedding = await this.generateEmbedding(embeddingInput, embeddingOptions); } catch { /* keep null, retry */ }
      }
    }

    if (!isValidEmbeddingVector(embedding)) {
      // Do NOT upsert a placeholder vector: a garbage point looks "present" to
      // the embed-reconciler and would never be re-embedded, permanently
      // polluting recall. Skip the upsert + log LOUD; the reconciler (or the next
      // save) will retry this id once embedding is available again.
      console.error(`⚠️ [qdrant] LOUD: embedding unavailable for memory ${memory.id} (org ${memory.org_id || memory.orgId || 'n/a'}) — SKIPPING upsert; embed-reconciler will retry`);
      if (trackManaged) await markVectorFailed(memory.id, 'embedding_unavailable');
      return null;
    }

    const point = {
      id: memory.id,
      vector: embedding,
      payload: {
        user_id: memory.user_id,
        org_id: memory.org_id,
        project: memory.project,
        project_ids: Array.isArray(memory.project_ids) ? memory.project_ids : [],
        team_id: memory.primary_team_id || null,
        memory_type: memory.memory_type,
        tags: memory.tags || [],
        // ITEM 5 — PAYLOAD IS AN INDEX, NOT A SECOND COPY OF THE TEXT. This carried the FULL
        // memory content: measured on the live collection, memory points averaged 1,277 bytes of
        // payload with one sampled point holding 3,272 chars, while evidence points sat at 478
        // because they already store only a preview. At million-document scale that is the single
        // largest avoidable cost in the vector store, and it is pure duplication — recall hydrates
        // every candidate from Postgres (persisted-retrieval.js: `if (!memory) return null` DROPS a
        // candidate that fails to hydrate, so no row ever reaches the ranker without PG content).
        // A bounded preview is kept because ranker.js and tara/prompt-builder.js read
        // `payload.content` as a defensive fallback; truncating rather than removing keeps them
        // working while cutting the bulk. Full text lives in Postgres, which is canonical.
        content: String(memory.content || '').slice(0, Number(process.env.QDRANT_PAYLOAD_PREVIEW_CHARS || 400)),
        is_latest: memory.is_latest ?? true,
        created_at: memory.created_at || new Date().toISOString(),
        valid_from: memory.valid_from || null,
        valid_to: memory.valid_to || null,
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
        layer,
        metadata: memory.metadata || {}
      }
    };

    // Remote .amr org (Model B, self-host): the vector + record belong on the CUSTOMER's hm-agent .amr,
    // NOT central Qdrant. Write to the agent and return — never touch central Qdrant for this org's data.
    if (orgIsRemote(memory.org_id)) {
      const _rrec = {
        id: memory.id, orgId: memory.org_id, userId: memory.user_id || null,
        // This record is the customer's canonical PostgreSQL row, not merely a
        // Qdrant payload. Sending the bounded vector-preview here overwrote the
        // full sovereign memory during the second-phase same-id upsert.
        content: String(memory.content || ''), title: memory.title || null, tags: memory.tags || [],
        memoryType: memory.memory_type || null, isLatest: memory.is_latest ?? true,
        layer: options.layer || memory.layer || (memory.cognitive_layer_role ? 'cognitive' : 'memory'),
        cognitiveLayerRole: memory.cognitive_layer_role || null,
        confidence: memory.importance_score ?? memory.strength ?? null,
        createdAt: memory.created_at || new Date().toISOString(),
        project: memory.project || null, projectIds: memory.project_ids || [],
        validFrom: memory.valid_from || null, validTo: memory.valid_to || null,
        documentDate: memory.document_date || null,
        metadata: memory.metadata || {},
      };
      try {
        const written = await amrWrite(memory.org_id, _rrec, point.vector);
        if (!written) return null; // durable outbox was enqueued by amrWrite
      } catch (e) {
        console.warn('[mneme] remote .amr write failed:', e.message);
        return null;
      }
      return { id: memory.id, status: 'amr-remote' };
    }

    try {
      const response = await fetch(
        `${qbase()}/collections/${collectionName}/points`,
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

      if (trackManaged) {
        // Retry pending here because legacy callers can invoke storeMemory just
        // before the authoritative memory transaction becomes visible.
        if (!ledgerPending) await markVectorPending(memory, collectionName);
        const recorded = await markVectorSynced(memory.id);
        if (!recorded) console.error(`[qdrant] vector ${memory.id} stored but managed sync ledger is unavailable`);
      }

      // mneme dual-write (best-effort): mirror this point into the org's .amr shard so reads can
      // be served from mneme for enabled orgs. Qdrant above remains the source of truth.
      if (mnemeOn(memory.org_id)) {
        mirrorStore(collectionName, point).catch(() => {});
      }

      // Path B: for the .amr-sole-store org, write the FULL record + vector into the adapter so
      // reads served from .amr carry the embedding + Prisma-shaped fields. Flag-gated; inert otherwise.
      if (isMnemeOrg(memory.org_id)) {
        try {
          const _rec = {
            id: memory.id, orgId: memory.org_id, userId: memory.user_id || null,
            content: String(memory.content || '').slice(0, Number(process.env.QDRANT_PAYLOAD_PREVIEW_CHARS || 400)), title: memory.title || null, tags: memory.tags || [],
            memoryType: memory.memory_type || null, isLatest: memory.is_latest ?? true,
            layer: options.layer || memory.layer || (memory.cognitive_layer_role ? 'cognitive' : 'memory'), deletedAt: null,
            cognitiveLayerRole: memory.cognitive_layer_role || null,
            confidence: memory.importance_score ?? memory.strength ?? null,
            createdAt: memory.created_at || new Date().toISOString(),
            project: memory.project || null, projectIds: memory.project_ids || [], primaryTeamId: memory.primary_team_id || null, scope: memory.scope || null, visibility: memory.visibility || null, validFrom: memory.valid_from || null, validTo: memory.valid_to || null, documentDate: memory.document_date || null, metadata: memory.metadata || {},
          };
          await amrWrite(memory.org_id, _rec, point.vector);
        } catch (e) { console.warn('[mneme] unified write failed:', e.message); }
      }

      return memory.id;
    } catch (error) {
      console.error('Failed to store memory in Qdrant:', error.message);
      if (trackManaged) await markVectorFailed(memory.id, error);
      // The authoritative PostgreSQL row can still succeed, but callers and the
      // reconciler must see that semantic indexing did not.
      return null;
    }
  }

  /**
   * Patch lifecycle metadata without replacing the vector. PostgreSQL remains
   * canonical; this keeps Qdrant's indexed eligibility fields synchronized so
   * metadata-first candidate generation does not admit a superseded point.
   */
  async updateMemoryPayload(memoryId, payload, { orgId, collectionName } = {}) {
    if (!memoryId || !orgId || !payload || typeof payload !== 'object') return false;
    if (orgIsRemote(orgId)) return true; // The BYOD agent updates its own point.

    const resolvedCollection = await routeCollection({ explicit: collectionName, orgId });
    const response = await fetch(
      `${qbase()}/collections/${resolvedCollection}/points/payload`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ payload, points: [memoryId], wait: true }),
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Qdrant payload update failed: ${response.status} ${detail}`);
    }
    return true;
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
  async searchMemories({ query, vector, filter, limit = 10, score_threshold = DEFAULT_SCORE_THRESHOLD, collectionName, hnsw_ef, layer, timing }) {
    const contextOrg = currentOrg() || globalThis.__hivemindOrgCtx?.currentOrg?.() || null;
    filter = enforceTenantFilter(filter, contextOrg);
    const _mnemeOrg = contextOrg || filterMatchValue(filter, 'org_id') || null;
    const usesSovereignBackend = Boolean(_mnemeOrg && memoryBackend(_mnemeOrg) !== 'central');
    // A sovereign tenant's search must not depend on central Qdrant readiness.
    // The prior ordering probed central Qdrant first and returned [] before it
    // ever called a perfectly healthy Memory Box.
    if (!usesSovereignBackend) {
      const connected = await this.isConnected();
      if (!connected) {
        console.warn('⚠️  Qdrant unavailable, search returning empty results');
        return [];
      }
    }

    // Route to the org container (org_<id>) / HIVEMIND_PERSONAL when per-tenant
    // is on and no explicit collection was given — derive org from the filter.
    const autoResolved = !collectionName && PER_TENANT;
    const resolvedCollection = await routeCollection({
      explicit: collectionName,
      orgId: _mnemeOrg,
    });

    // When we auto-routed into a shared org container, constrain to the memory
    // layer so evidence segments in the same collection don't leak into memory
    // recall. Explicit-collection callers (e.g. evidence-retrieval) own their
    // own layer filter and are left untouched.
    const effectiveLayer = layer ?? (autoResolved ? 'memory' : null);
    if (effectiveLayer && filter && Array.isArray(filter.must) && !filter.must.some((c) => c?.key === 'layer')) {
      filter = { ...filter, must: [...filter.must, { key: 'layer', match: { value: effectiveLayer } }] };
    }
    // Belt-and-braces with the layer filter: `promoted-from-segment` rows are raw
    // document sections promoted verbatim. They SHOULD be the evidence layer, but
    // legacy/untagged ones default to layer:'memory' and leak into recall as raw
    // multi-hundred-char dumps. Exclude the tag from auto-routed MEMORY recall so
    // recall returns distilled facts only. Mirrors the mneme backend exclusion
    // (mneme-backend.js:250). Explicit-collection callers (evidence retrieval) untouched.
    if (autoResolved && filter) {
      const mn = Array.isArray(filter.must_not) ? filter.must_not : [];
      if (!mn.some((c) => c?.key === 'tags' && c?.match?.value === 'promoted-from-segment')) {
        filter = { ...filter, must_not: [...mn, { key: 'tags', match: { value: 'promoted-from-segment' } }] };
      }
    }
    if (!usesSovereignBackend) {
      const collectionReady = await this.ensureCollection(resolvedCollection);
      if (!collectionReady) {
        console.warn('⚠️  Qdrant collection unavailable, search returning empty results');
        return [];
      }
    }

    // Generate query embedding if not provided
    let searchVector = vector;
    if (!searchVector && query) {
      const embeddingStartedAt = timing ? Date.now() : 0;
      searchVector = await this.generateEmbedding(query);
      if (timing) timing.embedding_ms = (timing.embedding_ms || 0) + (Date.now() - embeddingStartedAt);
    }

    if (!searchVector) {
      console.warn('⚠️  No vector available for search');
      return [];
    }

    const effectiveScoreThreshold = this.embedService?.provider === 'local-fallback'
      ? 0
      : score_threshold;

    // mneme read path: for enabled orgs, serve recall from the org's .amr shard with the SAME
    // score threshold + is_latest filter Qdrant would apply. Returns null on empty/error -> we
    // transparently fall through to Qdrant below.
    // Resolve the org from the filter OR the request's org context (the filter shape is unreliable —
    // hybridSearch passes org_id as an option and may not surface it in filter.must). The ONE seam,
    // memoryBackend(org), then decides: non-'central' → serve from the agent/.amr via amrRecall.
    if (_mnemeOrg && memoryBackend(_mnemeOrg) !== 'central') {
      try {
        const vectorStartedAt = timing ? Date.now() : 0;
        const _out = await amrRecall(_mnemeOrg, searchVector, filter, limit, effectiveScoreThreshold);
        if (timing) timing.vector_search_ms = (timing.vector_search_ms || 0) + (Date.now() - vectorStartedAt);
        if (_out) {
        console.log('[mneme] recall backend=adapter org=' + _mnemeOrg + ' n=' + _out.length);
        return _out;
        }
      } catch (e) {
        console.warn('[mneme] adapter recall failed:', e.message);
        if (orgIsRemote(_mnemeOrg)) throw e;
      }
    }
    if (mnemeOn(_mnemeOrg)) {
      const vectorStartedAt = timing ? Date.now() : 0;
      const mres = await mnemeSearch(resolvedCollection, searchVector, limit, {
        isLatest: true,
        scoreThreshold: effectiveScoreThreshold
      });
      if (timing) timing.vector_search_ms = (timing.vector_search_ms || 0) + (Date.now() - vectorStartedAt);
      if (mres) {
        console.log(`[mneme] recall backend=mneme org=${_mnemeOrg} coll=${resolvedCollection} n=${mres.length}`);
        return mres;
      }
      console.log(`[mneme] recall fallback=qdrant org=${_mnemeOrg} coll=${resolvedCollection}`);
    }

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
      const vectorStartedAt = timing ? Date.now() : 0;
      const response = await fetch(
        `${qbase()}/collections/${resolvedCollection}/points/search`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(searchRequest),
          signal: currentStageSignal() || undefined,
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Qdrant search failed: ${JSON.stringify(error)}`);
      }

      const result = await response.json();
      if (timing) timing.vector_search_ms = (timing.vector_search_ms || 0) + (Date.now() - vectorStartedAt);
      return result.result || [];
    } catch (error) {
      if (currentStageSignal()?.aborted) {
        console.warn('Qdrant search cancelled by the upstream recall deadline');
        throw error;
      } else {
        console.error('Failed to search memories:', error.message);
      }
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
    const filter = buildHybridSearchFilter(filters);

    return await this.searchMemories({
      query,
      filter,
      limit: filters.limit || 10,
      score_threshold: filters.score_threshold || 0.5,
      hnsw_ef: filters.hnsw_ef, // PHASE-F: thread per-org ef_search; inert when undefined (searchMemories → EF_SEARCH_DEFAULT). Dark-safe for all other hybridSearch callers.
      collectionName: filters.collectionName,
      timing: filters.timing,
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
        `${qbase()}/collections/${this.collectionName}/points/${memoryId}`,
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
        `${qbase()}/collections/${this.collectionName}/points/delete`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            points: [memoryId],
            wait: true
          })
        }
      );

      // mirror the delete into any enabled-org .amr shard that holds this memory (best-effort).
      mirrorDelete(memoryId).catch(() => {});

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
          // Bounded like the other payload writers — see the ITEM 5 note above; PG is canonical.
          content: String(memory.content || '').slice(0, Number(process.env.QDRANT_PAYLOAD_PREVIEW_CHARS || 400)),
          is_latest: memory.is_latest ?? true,
          created_at: memory.created_at || new Date().toISOString(),
          valid_from: memory.valid_from || null,
          valid_to: memory.valid_to || null,
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
        `${qbase()}/collections/${this.collectionName}/points`,
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

      // mneme dual-write (best-effort): mirror each enabled-org point into its .amr shard. Uses
      // org_<id> (enterprise per-tenant collection) to match the recall read key. Qdrant above
      // is the source of truth, so any skipped mirror is safe.
      for (const p of points) {
        const oid = p.payload?.org_id;
        if (mnemeOn(oid)) mirrorStore(`org_${oid}`, p).catch(() => {});
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
        `${qbase()}/collections/${this.collectionName}`,
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
      const response = await fetch(`${qbase()}/`, {
        headers,
        signal: currentStageSignal() || undefined,
      });
      if (response.ok) {
        console.log('✅ Qdrant connection successful');
        console.log(`   URL: ${qbase()}, Collection: ${this.collectionName}`);
        return true;
      } else {
        console.error('❌ Qdrant responded with status:', response.status);
        return false;
      }
    } catch (error) {
      if (currentStageSignal()?.aborted) throw error;
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

const { tokenizeApprox } = require('./chunkers/text-chunker');

// The custom BGE-M3 endpoint accepts at most 20 texts per request. Keeping
// this legacy ingestion path within the shared provider contract prevents an
// oversized batch from bypassing the primary and needlessly falling through
// custom BGE-M3 → BLAIQ BGE-M3 → OpenRouter BGE-M3.
const EMBEDDING_BATCH_SIZE = Math.max(1, Math.min(20, Number(process.env.KB_EMBED_BATCH_SIZE || 20)));
const MAX_EMBED_TOKENS = 8192;
// bge-m3 → 1024-dim. Env-driven so the target dim follows the configured embed
// model + Qdrant collection without re-creating it. (Timeout/retry now live in
// the bge-m3 factory client, not here.)
const TARGET_VECTOR_DIM = Number(process.env.EMBEDDING_DIMENSION) || 1536;

const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b(?:\d[ -]*?){13,16}\b/g, // credit card-ish
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, // email
  /\b\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, // phone
];

function stripAndFlagPII(text) {
  let output = String(text || '');
  let flagged = false;

  for (const pattern of PII_PATTERNS) {
    if (pattern.test(output)) {
      flagged = true;
      output = output.replace(pattern, '[REDACTED_PII]');
    }
  }

  return { text: output, pii_flagged: flagged };
}

function contextualPrepend(documentTitle, summary, chunkContent) {
  return `[CONTEXT: This chunk is from ${documentTitle}. It discusses ${summary}.]\n${chunkContent}`;
}

async function summarizeChunk(chunk, summaryModel) {
  if (summaryModel && typeof summaryModel.generateSummary === 'function') {
    return summaryModel.generateSummary(chunk);
  }

  const sentences = String(chunk)
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (sentences.length === 0) {
    return 'the primary ideas in this chunk in concise detail';
  }

  if (sentences.length === 1) {
    return `${sentences[0]} It provides supporting implementation details.`;
  }

  return `${sentences[0]} ${sentences[1]}`;
}

function normalizeVectorDimension(vector, targetDim = TARGET_VECTOR_DIM) {
  const normalized = Array.isArray(vector) ? vector.slice(0, targetDim) : [];
  while (normalized.length < targetDim) {
    normalized.push(0);
  }
  return normalized;
}

function makeDeterministicVector(text) {
  const vec = new Array(TARGET_VECTOR_DIM).fill(0);
  const input = String(text || '');

  for (let i = 0; i < input.length; i += 1) {
    const pos = i % TARGET_VECTOR_DIM;
    vec[pos] += ((input.charCodeAt(i) % 97) / 97);
  }

  return vec;
}

// (Legacy per-provider HTTP embed client removed — Mistral/OpenAI direct calls
// are gone; all embedding now flows through the canonical bge-m3 factory below,
// which has its own timeout + retry + fallback.)

// Unified embedding: delegates to the single canonical embed service (factory)
// — litellm/self-hosted bge-m3 PRIMARY + OpenRouter bge-m3 FALLBACK — the same
// 1024-dim vectors the recall + contextual-embed paths use. No api.mistral.ai,
// no provider chain duplicated here. Mistral is fully removed from the ingestion
// embed path (it had no key on prod → cold-start/failover latency + vectors that
// didn't match the bge-m3 fact embeddings in the same collection).
// (embedder.js is CommonJS; the factory is ESM → dynamic import.)
// Returns { vectors, embeddingModel } so the caller can record the actual source.
let _embedServicePromise = null;
async function _getEmbedService() {
  if (!_embedServicePromise) {
    _embedServicePromise = import('../embeddings/factory.js').then((m) => m.getEmbedService());
  }
  return _embedServicePromise;
}

async function embedBatchWithFallback(inputs, options = {}) { // eslint-disable-line no-unused-vars
  try {
    const svc = await _getEmbedService();
    const vectors = await svc.embed(inputs);
    const model = svc.getCacheStats?.()?.model
      || process.env.LITELLM_EMBED_MODEL
      || 'bge-m3';
    return {
      vectors: vectors.map((v) => normalizeVectorDimension(v)),
      embeddingModel: `${model}|normalized`,
    };
  } catch (err) {
    // Deterministic-vector escape hatch — explicit opt-in only, never silent.
    if (process.env.ALLOW_DETERMINISTIC_EMBEDDINGS === 'true') {
      console.warn('[embedder] bge-m3 embed service failed; deterministic fallback (ALLOW_DETERMINISTIC_EMBEDDINGS=true):', { inputs: inputs.length, err: err.message });
      return {
        vectors: inputs.map((input) => makeDeterministicVector(input)),
        embeddingModel: 'deterministic-fallback',
      };
    }
    throw err;
  }
}

async function embedChunks(chunks, context = {}, options = {}) {
  const documentTitle = context.documentTitle || 'document';
  const summaryModel = options.summaryModel;

  const prepared = [];

  for (const chunk of chunks) {
    const summary = await summarizeChunk(chunk.content, summaryModel);
    const contextualized = contextualPrepend(documentTitle, summary, chunk.content);
    const { text, pii_flagged } = stripAndFlagPII(contextualized);
    const tokenCount = tokenizeApprox(text).length;

    if (tokenCount > MAX_EMBED_TOKENS) {
      continue;
    }

    prepared.push({
      ...chunk,
      content_for_embedding: text,
      pii_flagged,
      contextual_summary: summary,
      embedding_token_count: tokenCount,
    });
  }

  for (let i = 0; i < prepared.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = prepared.slice(i, i + EMBEDDING_BATCH_SIZE);
    // FIX C3: destructure the actual provider label returned by embedBatchWithFallback.
    const { vectors, embeddingModel } = await embedBatchWithFallback(
      batch.map((item) => item.content_for_embedding),
      options
    );

    batch.forEach((item, index) => {
      item.embedding = normalizeVectorDimension(vectors[index]);
      // Record the ACTUAL provider/model used, captured before normalizeVectorDimension.
      item.embedding_model = embeddingModel;
    });
  }

  return prepared;
}

module.exports = {
  embedChunks,
  EMBEDDING_BATCH_SIZE,
  MAX_EMBED_TOKENS,
  stripAndFlagPII,
  contextualPrepend,
};

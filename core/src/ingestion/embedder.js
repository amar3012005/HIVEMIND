const { tokenizeApprox } = require('./chunkers/text-chunker');

const EMBEDDING_BATCH_SIZE = 32;
const MAX_EMBED_TOKENS = 8192;
// Match the existing Qdrant collection dimension. Env-driven so we can switch
// between BGE-small (384), Mistral (1024), and OpenAI text-embedding-3-small
// (1536) without re-creating the collection.
const TARGET_VECTOR_DIM = Number(process.env.EMBEDDING_DIMENSION) || 1536;

const EMBED_TIMEOUT_MS = 30_000;
const EMBED_MAX_RETRIES = 3;
const EMBED_BACKOFF_BASE_MS = 500;

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

// FIX H2: wraps a single POST to an embeddings endpoint with a hard timeout
// and exponential-backoff retry on 429/5xx, honouring Retry-After.
// FIX C3: baseURL + apiKey + model are explicit arguments; nothing is hardcoded.
async function requestEmbeddingModel(model, inputs, apiKey, baseURL) {
  const url = `${baseURL}/embeddings`;

  // Mistral uses `inputs`; OpenAI uses `input`.  Both providers accept either
  // key without error in practice, but send the idiomatic key for the endpoint.
  const isMistral = baseURL.includes('mistral.ai');
  const bodyKey = isMistral ? 'inputs' : 'input';

  let attempt = 0;

  while (attempt <= EMBED_MAX_RETRIES) {
    // FIX H2: abort after EMBED_TIMEOUT_MS per attempt.
    const signal =
      typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(EMBED_TIMEOUT_MS)
        : (() => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
            // store timer reference on signal so caller can clearTimeout if needed
            controller.signal._timer = timer;
            return controller.signal;
          })();

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          [bodyKey]: inputs,
          encoding_format: 'float',
        }),
        signal,
      });
    } finally {
      // clean up manual timer if we created one
      if (signal._timer !== undefined) {
        clearTimeout(signal._timer);
      }
    }

    if (response.ok) {
      const payload = await response.json();
      return payload.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
    }

    // FIX H2: back off on 429 / 5xx; fail fast on 4xx auth/bad-request errors.
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= EMBED_MAX_RETRIES) {
      const errorText = await response.text();
      throw new Error(`Embedding request failed [${response.status}] (${model} @ ${baseURL}): ${errorText}`);
    }

    // Honour Retry-After if the provider sends it.
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? parseFloat(retryAfterHeader) : NaN;
    const backoffBase = Number.isFinite(retryAfterSec)
      ? retryAfterSec * 1000
      : EMBED_BACKOFF_BASE_MS * 2 ** attempt;
    const jitter = Math.random() * backoffBase * 0.25;
    const delay = Math.round(backoffBase + jitter);

    console.warn('[embedder] retryable error — backing off:', { model, baseURL, status: response.status, attempt, delayMs: delay });

    await new Promise((resolve) => setTimeout(resolve, delay));
    attempt += 1;
  }

  // Unreachable — while condition ensures we throw inside the loop above.
  throw new Error(`Embedding retry loop exhausted for model ${model}`);
}

// FIX C3: real two-provider fallback.  Primary = Mistral, real fallback =
// OpenAI (only when OPENAI_API_KEY is set).  If both fail, THROW — do NOT emit
// deterministic garbage vectors unless ALLOW_DETERMINISTIC_EMBEDDINGS is set.
// Returns { vectors, embeddingModel } so the caller can record the actual source.
async function embedBatchWithFallback(inputs, options = {}) {
  const mistralKey = options.apiKey || process.env.MISTRAL_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  let primaryError = null;

  // Primary: Mistral
  if (mistralKey) {
    try {
      const vectors = await requestEmbeddingModel(
        'mistral-embed',
        inputs,
        mistralKey,
        'https://api.mistral.ai/v1'
      );
      return {
        vectors: vectors.map((v) => normalizeVectorDimension(v)),
        embeddingModel: 'mistral-embed|normalized',
      };
    } catch (err) {
      primaryError = err;
      console.error('[embedder] primary provider (mistral) failed:', err.message);
    }
  }

  // Real fallback: OpenAI — only when key is present.
  if (openaiKey) {
    try {
      const vectors = await requestEmbeddingModel(
        'text-embedding-3-small',
        inputs,
        openaiKey,
        'https://api.openai.com/v1'
      );
      return {
        vectors: vectors.map((v) => normalizeVectorDimension(v)),
        embeddingModel: 'text-embedding-3-small|normalized',
      };
    } catch (fallbackErr) {
      console.error('[embedder] fallback provider (openai) failed:', fallbackErr.message, '| primary:', primaryError ? primaryError.message : 'n/a');

      // FIX C3: deterministic-vector escape hatch — explicit opt-in only.
      if (process.env.ALLOW_DETERMINISTIC_EMBEDDINGS === 'true') {
        console.warn('[embedder] both providers failed; deterministic fallback (ALLOW_DETERMINISTIC_EMBEDDINGS=true):', { inputs: inputs.length });
        return {
          vectors: inputs.map((input) => makeDeterministicVector(input)),
          embeddingModel: 'deterministic-fallback',
        };
      }

      const combined = new Error(
        `All embedding providers failed. Primary: ${primaryError ? primaryError.message : 'no Mistral key'}. Fallback: ${fallbackErr.message}`
      );
      combined.primaryError = primaryError;
      combined.fallbackError = fallbackErr;
      throw combined;
    }
  }

  // No keys at all: deterministic escape hatch (opt-in) or hard throw.
  if (process.env.ALLOW_DETERMINISTIC_EMBEDDINGS === 'true') {
    console.warn('[embedder] no API keys configured; deterministic fallback (ALLOW_DETERMINISTIC_EMBEDDINGS=true):', { inputs: inputs.length });
    return {
      vectors: inputs.map((input) => makeDeterministicVector(input)),
      embeddingModel: 'deterministic-fallback',
    };
  }

  const noKeyErr = new Error(
    `No embedding API keys configured (MISTRAL_API_KEY / OPENAI_API_KEY) and ALLOW_DETERMINISTIC_EMBEDDINGS is not set. Primary error: ${primaryError ? primaryError.message : 'n/a'}`
  );
  noKeyErr.primaryError = primaryError;
  throw noKeyErr;
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

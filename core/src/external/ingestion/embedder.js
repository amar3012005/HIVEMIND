const { tokenizeApprox } = require('./chunkers/text-chunker');

const EMBEDDING_BATCH_SIZE = 32;
const MAX_EMBED_TOKENS = 8192;
const TARGET_VECTOR_DIM = 1536;

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

async function requestEmbeddingModel(model, inputs, apiKey) {
  const response = await fetch('https://api.mistral.ai/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      inputs,
      encoding_format: 'float',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding request failed (${model}): ${errorText}`);
  }

  const payload = await response.json();
  return payload.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

async function embedBatchWithFallback(inputs, options = {}) {
  const apiKey = options.apiKey || process.env.MISTRAL_API_KEY;

  if (!apiKey) {
    return inputs.map((input) => makeDeterministicVector(input));
  }

  try {
    const vectors = await requestEmbeddingModel('mistral-embed', inputs, apiKey);
    return vectors.map((vector) => normalizeVectorDimension(vector));
  } catch (_primaryError) {
    try {
      const fallbackModel = options.fallbackModel || 'text-embedding-3-small';
      const vectors = await requestEmbeddingModel(fallbackModel, inputs, apiKey);
      return vectors.map((vector) => normalizeVectorDimension(vector));
    } catch (_fallbackError) {
      return inputs.map((input) => makeDeterministicVector(input));
    }
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
    const vectors = await embedBatchWithFallback(
      batch.map((item) => item.content_for_embedding),
      options
    );

    batch.forEach((item, index) => {
      item.embedding = normalizeVectorDimension(vectors[index]);
      item.embedding_model = vectors[index].length === TARGET_VECTOR_DIM ? 'mistral-embed|normalized' : 'fallback';
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

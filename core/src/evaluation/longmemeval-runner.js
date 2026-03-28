#!/usr/bin/env node
/**
 * LongMemEval-S Benchmark Runner for HIVEMIND
 *
 * Ingests LongMemEval_S dataset session-by-session into HIVEMIND,
 * runs retrieval + generation for all 500 questions,
 * outputs hypothesis JSONL for the official evaluate_qa.py script.
 *
 * Usage:
 *   node longmemeval-runner.js --phase ingest     # Ingest all sessions
 *   node longmemeval-runner.js --phase evaluate    # Run queries + generate answers
 *   node longmemeval-runner.js --phase both        # Full pipeline
 *   node longmemeval-runner.js --phase evaluate --sample 10  # Quick test with 10 questions
 *
 * Requires: GROQ_API_KEY, HIVEMIND core API running
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { buildBenchmarkContext, getLongMemEvalRetrievalPlan } from './longmemeval-routing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = process.env.LONGMEMEVAL_DATA || path.join(__dirname, '../../../benchmarks/LongMemEval/data/longmemeval_s_cleaned.json');
const OUTPUT_DIR = path.join(__dirname, '../../evaluation-reports');
const HYPOTHESIS_FILE = path.join(OUTPUT_DIR, 'longmemeval-hypotheses.jsonl');
const LONGMEMEVAL_REPORT_FILE = path.join(OUTPUT_DIR, 'longmemeval-report.json');

// HIVEMIND API config
const API_BASE = process.env.HIVEMIND_API_BASE || 'https://core.hivemind.davinciai.eu:8050';
const API_KEY = process.env.HIVEMIND_API_KEY || process.env.HIVEMIND_MASTER_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_INFERENCE_MODEL || 'llama-3.3-70b-versatile';
const REASONING_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];

// LiteLLM config for stronger generation models (GPT-4o-mini, Gemini, Claude)
const LITELLM_BASE = process.env.LITELLM_BASE_URL || process.env.OPENAI_API_BASE_URL || '';
const LITELLM_KEY = process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY || '';
const LITELLM_MODEL = process.env.LITELLM_MODEL || 'gpt-4o-mini';

// Benchmark Qdrant collection with bge-m3 embeddings (direct access, bypasses server embed)
const BENCHMARK_QDRANT_URL = process.env.QDRANT_URL || 'https://24826665-41d6-4ea6-b13f-fc42438c4c55.eu-central-1-0.aws.cloud.qdrant.io:6333';
const BENCHMARK_QDRANT_KEY = process.env.QDRANT_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIn0.fo75c0vRt9MhfhcQB0fP-m-MiU4gCYZD_yv23YNtyJc';
const BENCHMARK_COLLECTION = process.env.BENCHMARK_QDRANT_COLLECTION || 'BENCHMARK';
const BENCHMARK_EMBED_MODEL = process.env.BENCHMARK_EMBED_MODEL || 'bge-m3';
const BENCHMARK_MODE = process.env.LONGMEMEVAL_BENCHMARK_MODE || 'hybrid';
const LONGMEMEVAL_CLEANUP = process.env.LONGMEMEVAL_CLEANUP !== '0';

// Benchmark user/org (isolated tenant)
const BENCH_USER = 'longmemeval-bench-001';
const BENCH_ORG = 'longmemeval-org-001';

// ── CLI args ─────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    phase: 'all',
    sample: 0,
    startFrom: 0,
    concurrency: 1,
    benchmarkMode: BENCHMARK_MODE,
    cleanup: LONGMEMEVAL_CLEANUP,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--phase': opts.phase = args[++i]; break;
      case '--sample': opts.sample = parseInt(args[++i], 10); break;
      case '--start-from': opts.startFrom = parseInt(args[++i], 10); break;
      case '--concurrency': opts.concurrency = parseInt(args[++i], 10); break;
      case '--benchmark-mode': opts.benchmarkMode = args[++i]; break;
      case '--cleanup': opts.cleanup = args[++i] !== 'false'; break;
      case '--help': case '-h':
        console.log(`
LongMemEval-S Benchmark Runner

Usage: node longmemeval-runner.js [options]

Options:
  --phase ingest|evaluate|judge|all   Pipeline phase (default: all = ingest+evaluate+judge)
  --sample N                     Only process N instances (default: all 500)
  --start-from N                 Start from instance N (default: 0)
  --concurrency N                Parallel instances (default: 1)
  --benchmark-mode direct|engine|hybrid
                                Retrieval/index mode (default: hybrid)
  --cleanup true|false          Delete per-question memories after stream mode (default: true)
`);
        process.exit(0);
    }
  }
  if (!['direct', 'engine', 'hybrid'].includes(opts.benchmarkMode)) {
    throw new Error(`Unsupported benchmark mode: ${opts.benchmarkMode}`);
  }
  return opts;
}

function makeRunConfig(opts = {}, benchCollectionReady = true) {
  const benchmarkMode = opts.benchmarkMode || BENCHMARK_MODE;
  const useBenchmarkCollection = benchCollectionReady && benchmarkMode !== 'engine';
  const useServerMemory = benchmarkMode !== 'direct';
  return {
    benchmarkMode,
    cleanup: opts.cleanup ?? LONGMEMEVAL_CLEANUP,
    useBenchmarkCollection,
    useServerMemory,
    benchCollectionReady
  };
}

// ── API helpers ──────────────────────────────────────────

async function apiCall(method, path, body = null) {
  const url = `${API_BASE}${path}`;
  const headers = {
    'X-API-Key': API_KEY,
    'Content-Type': 'application/json',
    'X-HM-User-Id': BENCH_USER,
    'X-HM-Org-Id': BENCH_ORG,
  };

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API ${method} ${path}: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// ── Benchmark collection helpers (bge-m3 + direct Qdrant) ──

/**
 * Embed texts using LiteLLM bge-m3 model (1024-dim vectors)
 * @param {string[]} texts - Array of texts to embed
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
async function litellmEmbed(texts) {
  const base = LITELLM_BASE;
  const key = LITELLM_KEY;
  if (!base || !key) {
    throw new Error('LiteLLM not configured for benchmark embeddings — set LITELLM_BASE_URL and LITELLM_API_KEY');
  }
  const resp = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: BENCHMARK_EMBED_MODEL, input: texts }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LiteLLM embed ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.data.map(d => d.embedding);
}

/**
 * Direct Qdrant API call (bypasses server's QdrantClient)
 */
async function benchmarkQdrant(method, urlPath, body = null) {
  const opts = {
    method,
    headers: { 'api-key': BENCHMARK_QDRANT_KEY, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${BENCHMARK_QDRANT_URL}${urlPath}`, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Qdrant ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Ensure the BENCHMARK collection exists in Qdrant (1024-dim, cosine)
 */
async function ensureBenchmarkCollection() {
  try {
    const resp = await fetch(`${BENCHMARK_QDRANT_URL}/collections/${BENCHMARK_COLLECTION}`, {
      headers: { 'api-key': BENCHMARK_QDRANT_KEY, 'Content-Type': 'application/json' },
    });
    if (resp.ok) return true;
    if (resp.status === 404) {
      // Create collection with 1024-dim cosine vectors (bge-m3)
      await benchmarkQdrant('PUT', `/collections/${BENCHMARK_COLLECTION}`, {
        vectors: { size: 1024, distance: 'Cosine' },
      });
      console.log(`[benchmark] Created BENCHMARK collection (1024-dim, cosine)`);
    }
    // Ensure payload indices exist for temporal filtering
    try {
      await benchmarkQdrant('PUT', `/collections/${BENCHMARK_COLLECTION}/index`, {
        field_name: 'session_idx', field_schema: 'integer'
      });
    } catch (idxErr) {
      console.warn(`[benchmark] session_idx index creation skipped: ${idxErr.message}`);
    }
    return true;
  } catch (err) {
    console.error(`[benchmark] Failed to ensure collection: ${err.message}`);
    return false;
  }
}

/**
 * Generate a numeric point ID from a string key (deterministic hash)
 */
function benchmarkPointId(key) {
  let hash = 0;
  for (let c = 0; c < key.length; c++) {
    hash = ((hash << 5) - hash + key.charCodeAt(c)) | 0;
  }
  return Math.abs(hash) % 2147483647;
}

/**
 * Store a batch of memories in the BENCHMARK collection with bge-m3 embeddings
 */
async function benchmarkUpsert(points) {
  await benchmarkQdrant('PUT', `/collections/${BENCHMARK_COLLECTION}/points`, {
    points,
    wait: true,
  });
}

/**
 * Search the BENCHMARK collection with a bge-m3 query vector
 */
async function benchmarkSearch(queryVec, questionId, limit = 20) {
  const result = await benchmarkQdrant('POST', `/collections/${BENCHMARK_COLLECTION}/points/search`, {
    vector: queryVec,
    limit,
    with_payload: true,
    filter: {
      must: [{ key: 'question_id', match: { value: questionId } }],
    },
  });
  return (result.result || []).map(r => ({
    id: r.id,
    content: r.payload?.content || '',
    score: r.score,
    title: r.payload?.title || '',
    date: r.payload?.session_date || r.payload?.document_date || null,
    project: r.payload?.project || null,
    session: r.payload?.session_idx,
    memoryType: r.payload?.memory_type || null,
    tags: r.payload?.tags || [],
  }));
}

/**
 * Delete benchmark points for a question from the BENCHMARK collection
 */
async function benchmarkCleanup(questionId) {
  try {
    await benchmarkQdrant('POST', `/collections/${BENCHMARK_COLLECTION}/points/delete`, {
      filter: { must: [{ key: 'question_id', match: { value: questionId } }] },
      wait: true,
    });
  } catch (err) {
    console.warn(`[benchmark] Cleanup failed for ${questionId}: ${err.message.slice(0, 80)}`);
  }
}

async function litellmChat(messages, options = {}) {
  if (!LITELLM_BASE || !LITELLM_KEY) {
    throw new Error('LiteLLM not configured — set LITELLM_BASE_URL and LITELLM_API_KEY');
  }
  const model = options.model || LITELLM_MODEL;
  const resp = await fetch(`${LITELLM_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LITELLM_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      max_tokens: options.maxTokens || 500,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LiteLLM ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices[0].message.content;
}

async function groqChat(messages, options = {}) {
  const maxRetries = 3;
  const model = options.model || GROQ_MODEL;
  const isReasoning = REASONING_MODELS.some(m => model.includes(m));

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const body = {
      model,
      messages,
      max_tokens: options.maxTokens || 300,
    };

    // Reasoning models (gpt-oss-*): disable reasoning to get content directly
    if (isReasoning) {
      body.include_reasoning = false;
      // Reasoning models don't support temperature
    } else {
      body.temperature = 0;
    }

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (resp.status === 429 || resp.status === 503) {
      const wait = Math.pow(2, attempt + 1) * 1000;
      console.warn(`  [rate-limit] Groq ${resp.status}, retrying in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Groq API: ${resp.status} ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    return data.choices[0].message.content;
  }
  throw new Error('Groq API: max retries exceeded');
}

function normalizeSearchResult(result, rank = 0) {
  if (!result) return null;
  const payload = result.payload || {};
  const content = result.content || payload.content || '';
  const metadata = result.metadata || payload.metadata || {};
  const sourceMetadata = result.source_metadata || payload.source_metadata || {};
  const date = result.document_date
    || result.documentDate
    || payload.document_date
    || payload.documentDate
    || result.session_date
    || payload.session_date
    || metadata.session_date
    || metadata.document_date
    || sourceMetadata.session_date
    || result.created_at
    || payload.created_at
    || null;

  return {
    id: result.id || payload.id || payload.memoryId || null,
    title: result.title || payload.title || '',
    content,
    score: Number.isFinite(result.score) ? result.score : (Number.isFinite(payload.score) ? payload.score : null),
    project: result.project || payload.project || null,
    tags: result.tags || payload.tags || [],
    session: result.session || payload.session || null,
    memoryType: result.memoryType || payload.memoryType || payload.memory_type || null,
    sourcePlatform: result.sourcePlatform || payload.sourcePlatform || null,
    date,
    rank: rank + 1
  };
}

function normalizeSearchResults(searchResults) {
  const items = searchResults?.results || searchResults?.memories || [];
  return items
    .map((result, rank) => normalizeSearchResult(result, rank))
    .filter(item => item && (item.content || item.title || item.id));
}

function selectContextResults(searchResults, limit = 5) {
  const normalized = normalizeSearchResults(searchResults);
  const selected = [];
  const seen = new Set();

  for (const item of normalized) {
    const contentKey = (item.content || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const signature = contentKey
      || item.id
      || `${(item.title || '').toLowerCase()}::${(item.content || '').slice(0, 160).toLowerCase().replace(/\s+/g, ' ')}`;

    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    selected.push(item);
    if (selected.length >= limit) break;
  }

  return selected;
}

function mergeRetrievalResults(primaryResults, secondaryResults, limit = 15) {
  const merged = [];
  const seenIds = new Set();
  const seenContent = new Set();

  for (const source of [primaryResults, secondaryResults]) {
    for (const item of normalizeSearchResults(source)) {
      const contentKey = (item.content || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      const identity = item.id || null;

      if ((identity && seenIds.has(identity)) || (contentKey && seenContent.has(contentKey))) {
        continue;
      }

      if (identity) seenIds.add(identity);
      if (contentKey) seenContent.add(contentKey);
      merged.push(item);

      if (merged.length >= limit) {
        return merged;
      }
    }
  }

  return merged;
}

const TEMPORAL_COMPARISON_PATTERNS = {
  first: /\b(first|earlier|earliest|came first)\b/i,
  last: /\b(last|later|latest|newest|came last)\b/i,
  dayDiff: /\bhow many days\b/i
};

const TEMPORAL_EVENT_SIGNAL = /\b(attended|joined|bought|purchased|scheduled|met|went|prepared|preparing|participated|ordered|got)\b/i;
const EVENT_NOUN_PATTERN = /\b(workshop|webinar|meeting|trip|vacation|conference|phone|tablet|device|bike|car)\b/i;

function parseComparableDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function normalizePhrase(phrase = '') {
  return phrase
    .toLowerCase()
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractQuestionTargets(question = '') {
  const quoted = (question.match(/"([^"]+)"/g) || []).map(part => part.slice(1, -1).trim());
  if (quoted.length >= 2) {
    return [...new Set(quoted)];
  }

  const alternatives = [];
  for (const match of question.matchAll(/\bthe\s+([^?]+?)\s+or\s+the\s+([^?]+?)(?:\?|$)/gi)) {
    alternatives.push(match[1].trim(), match[2].trim());
  }

  const capitalized = (question.match(/\b[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*/g) || [])
    .filter(token => !['Which', 'What', 'How', 'Did', 'I', 'The'].includes(token));

  const eventPhrases = [];
  for (const match of question.matchAll(/\b(?:the|a|an)\s+([a-z0-9][a-z0-9' -]{1,50}?(?:workshop|webinar|meeting|trip|vacation|conference|phone|tablet|device|bike|car))\b/gi)) {
    eventPhrases.push(match[1].trim());
  }

  return [...new Set([...alternatives, ...capitalized, ...eventPhrases])].filter(Boolean);
}

function extractTemporalEvidence(question, results = []) {
  const targets = extractQuestionTargets(question);
  const normalizedTargets = targets.map(normalizePhrase);

  return results
    .map((result, index) => {
      const date = parseComparableDate(result.date);
      const content = result.content || '';
      const title = result.title || '';
      const haystack = `${title}\n${content}`;
      const normalizedHaystack = normalizePhrase(haystack);
      const matchedTargets = targets.filter((target, targetIndex) => {
        const normalized = normalizedTargets[targetIndex];
        return normalized && normalizedHaystack.includes(normalized);
      });

      return {
        memoryId: result.id,
        rank: index + 1,
        date,
        isoDate: date ? date.toISOString() : null,
        content,
        title,
        matchedTargets,
        hasEventSignal: TEMPORAL_EVENT_SIGNAL.test(haystack) || EVENT_NOUN_PATTERN.test(haystack),
        snippet: haystack.replace(/\s+/g, ' ').trim().slice(0, 220)
      };
    })
    .filter(item => item.date || item.matchedTargets.length > 0 || item.hasEventSignal)
    .sort((left, right) => {
      if (left.date && right.date) return left.date - right.date;
      if (left.date) return -1;
      if (right.date) return 1;
      return left.rank - right.rank;
    });
}

function buildTemporalEvidenceContext(question, evidence = []) {
  const lines = evidence
    .filter(item => item.date)
    .slice(0, 6)
    .map(item => {
      const targetLabel = item.matchedTargets.length > 0
        ? item.matchedTargets.join(' | ')
        : (item.title || item.snippet);
      return `- ${targetLabel} — ${item.isoDate?.slice(0, 10) || 'unknown'} — ${item.snippet}`;
    });

  if (lines.length === 0) {
    return '';
  }

  return [
    'Structured Temporal Evidence:',
    ...lines,
    '',
    `Question: ${question}`
  ].join('\n');
}

function pickTargetDate(target, evidence = []) {
  const normalizedTarget = normalizePhrase(target);
  const candidates = evidence.filter(item =>
    item.date && item.matchedTargets.some(match => normalizePhrase(match) === normalizedTarget)
  );
  if (candidates.length === 0) return null;
  return candidates[0];
}

function answerTemporalQuestion(question, evidence = []) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return null;
  }

  const targets = extractQuestionTargets(question);
  const datedEvidence = evidence.filter(item => item.date);
  if (datedEvidence.length === 0) {
    return null;
  }

  if (TEMPORAL_COMPARISON_PATTERNS.dayDiff.test(question)) {
    const datedTargets = targets
      .map(target => ({ target, candidate: pickTargetDate(target, evidence) }))
      .filter(entry => entry.candidate);
    const first = datedTargets[0]?.candidate || datedEvidence[0];
    const second = datedTargets[1]?.candidate || datedEvidence[1];
    if (first?.date && second?.date) {
      const diffDays = Math.round(Math.abs(second.date - first.date) / (1000 * 60 * 60 * 24));
      return {
        answer: String(diffDays),
        confidence: 0.92,
        mode: 'deterministic',
        evidenceCount: 2
      };
    }
  }

  const targetCandidates = targets
    .map(target => ({ target, candidate: pickTargetDate(target, evidence) }))
    .filter(entry => entry.candidate);

  if (targetCandidates.length >= 2) {
    const sorted = [...targetCandidates].sort((left, right) => left.candidate.date - right.candidate.date);
    if (TEMPORAL_COMPARISON_PATTERNS.first.test(question)) {
      return {
        answer: sorted[0].target,
        confidence: 0.95,
        mode: 'deterministic',
        evidenceCount: sorted.length
      };
    }
    if (TEMPORAL_COMPARISON_PATTERNS.last.test(question)) {
      return {
        answer: sorted[sorted.length - 1].target,
        confidence: 0.95,
        mode: 'deterministic',
        evidenceCount: sorted.length
      };
    }
  }

  if (TEMPORAL_COMPARISON_PATTERNS.first.test(question) || TEMPORAL_COMPARISON_PATTERNS.last.test(question)) {
    const sorted = [...datedEvidence].sort((left, right) => left.date - right.date);
    const chosen = TEMPORAL_COMPARISON_PATTERNS.first.test(question) ? sorted[0] : sorted[sorted.length - 1];
    const fallbackLabel = chosen.matchedTargets[0] || chosen.title || chosen.snippet;
    if (fallbackLabel) {
      return {
        answer: fallbackLabel,
        confidence: 0.7,
        mode: 'fallback_deterministic',
        evidenceCount: sorted.length
      };
    }
  }

  return null;
}

function isTemporalReasoningQuestion(question, questionType) {
  return questionType === 'temporal-reasoning'
    || TEMPORAL_COMPARISON_PATTERNS.first.test(question || '')
    || TEMPORAL_COMPARISON_PATTERNS.last.test(question || '')
    || TEMPORAL_COMPARISON_PATTERNS.dayDiff.test(question || '');
}

function buildGenerationPrompt({ context, question, questionDate, systemHint, structuredEvidence }) {
  const dateStr = questionDate || 'Unknown';

  if (context.length > 50) {
    const hintLine = systemHint ? `\nNote: ${systemHint}` : '';
    const evidenceLine = structuredEvidence ? `\nStructured Evidence:\n${structuredEvidence}\n` : '\n';
    return `Return a short direct answer using only the retrieved memory context. Do not explain your reasoning.${hintLine}\n\nRetrieved Memory Context:\n${context}${evidenceLine}Current Date: ${dateStr}\nQuestion: ${question}\nAnswer:`;
  }

  return `Return a short direct answer using only the provided memory evidence. Do not explain your reasoning.\nCurrent Date: ${dateStr}\nQuestion: ${question}\nAnswer:`;
}

function looksLikeAbstention(text) {
  return /don't have this information in my memory|do not have this information in my memory|i don't know|i do not know|cannot find|can't find|not enough context|not in my memory/i.test(text || '');
}

function classifyLongMemEvalBottleneck(entry) {
  const retrieval = entry.retrieval || {};
  const resultCount = retrieval.resultCount || 0;
  const contextChars = retrieval.contextChars || 0;
  const fallbackUsed = !!retrieval.usedGlobalFallback;
  const hypothesis = entry.hypothesis || '';
  const isAbstentionAnswer = looksLikeAbstention(hypothesis);
  const judged = typeof entry.autoeval_label === 'string';
  const correct = entry.autoeval_label === 'yes';

  if (entry.isAbstention && judged && correct) {
    return {
      type: 'abstention_success',
      severity: 'low',
      reason: 'The model correctly abstained on an unanswerable question',
      evidence: {
        hypothesis: hypothesis.slice(0, 120)
      }
    };
  }

  if (entry.isAbstention && judged && !correct) {
    return {
      type: 'abstention_failure',
      severity: 'high',
      reason: 'The model failed to handle an unanswerable question correctly',
      evidence: {
        questionType: entry.question_type,
        hypothesis: hypothesis.slice(0, 120)
      }
    };
  }

  if (!entry.isAbstention && judged && !correct && isAbstentionAnswer) {
    return {
      type: 'over_abstention',
      severity: 'high',
      reason: 'Answerable question was abstained',
      evidence: {
        questionType: entry.question_type,
        hypothesis: hypothesis.slice(0, 120)
      }
    };
  }

  if (resultCount === 0) {
    return {
      type: 'empty_context',
      severity: 'high',
      reason: 'No retrieval context was returned',
      evidence: {
        resultCount,
        contextChars
      }
    };
  }

  if (fallbackUsed) {
    return {
      type: 'scope_fallback',
      severity: 'medium',
      reason: 'Project-scoped retrieval required a global fallback',
      evidence: {
        projectResultCount: retrieval.projectResultCount || 0,
        globalResultCount: retrieval.globalResultCount || 0
      }
    };
  }

  if (contextChars < 120) {
    return {
      type: 'thin_context',
      severity: 'medium',
      reason: 'The generated context was too small to support answering',
      evidence: {
        contextChars,
        resultCount
      }
    };
  }

  if (judged && !correct) {
    return {
      type: 'generation_or_reasoning_gap',
      severity: 'medium',
      reason: 'Context existed, but the final answer was still incorrect',
      evidence: {
        questionType: entry.question_type,
        hypothesis: hypothesis.slice(0, 120)
      }
    };
  }

  return {
    type: 'healthy',
    severity: 'low',
    reason: 'No dominant bottleneck detected',
    evidence: {
      resultCount,
      contextChars
    }
  };
}

function mean(values) {
  const filtered = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (filtered.length === 0) return 0;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function summarizeEntries(entries) {
  const total = entries.length;
  const answerable = entries.filter(entry => !entry.isAbstention).length;
  const abstention = total - answerable;
  const judged = entries.filter(entry => typeof entry.autoeval_label === 'string');
  const correct = judged.filter(entry => entry.autoeval_label === 'yes').length;

  const retrieval = {
    averageSearchLatencyMs: Math.round(mean(entries.map(entry => entry.retrieval?.searchLatencyMs)) * 100) / 100,
    averageGenerationLatencyMs: Math.round(mean(entries.map(entry => entry.retrieval?.generationLatencyMs)) * 100) / 100,
    averageJudgeLatencyMs: Math.round(mean(entries.map(entry => entry.retrieval?.judgeLatencyMs)) * 100) / 100,
    averageIngestLatencyMs: Math.round(mean(entries.map(entry => entry.retrieval?.ingestLatencyMs)) * 100) / 100,
    averageCleanupLatencyMs: Math.round(mean(entries.map(entry => entry.retrieval?.cleanupLatencyMs)) * 100) / 100,
    averageContextChars: Math.round(mean(entries.map(entry => entry.retrieval?.contextChars)) * 100) / 100,
    averageResultCount: Math.round(mean(entries.map(entry => entry.retrieval?.resultCount)) * 100) / 100,
    projectScopedCount: entries.filter(entry => (entry.retrieval?.projectResultCount || 0) > 0).length,
    fallbackCount: entries.filter(entry => entry.retrieval?.usedGlobalFallback).length,
    emptyContextCount: entries.filter(entry => (entry.retrieval?.resultCount || 0) === 0).length
  };

  const judgedSummary = judged.length > 0
    ? {
        judged: judged.length,
        correct,
        accuracy: Math.round((correct / judged.length) * 10000) / 100,
        answerable: judged.filter(entry => !entry.isAbstention).length,
        abstention: judged.filter(entry => entry.isAbstention).length
      }
    : {
        judged: 0,
        correct: 0,
        accuracy: 0,
        answerable: 0,
        abstention: 0
      };

  const byQuestionType = {};
  for (const entry of judged) {
    const type = entry.question_type || 'unknown';
    if (!byQuestionType[type]) {
      byQuestionType[type] = {
        total: 0,
        correct: 0,
        fallbackCount: 0,
        emptyContextCount: 0,
        averageContextChars: 0,
        averageSearchLatencyMs: 0
      };
    }
    const bucket = byQuestionType[type];
    bucket.total += 1;
    if (entry.autoeval_label === 'yes') bucket.correct += 1;
    if (entry.retrieval?.usedGlobalFallback) bucket.fallbackCount += 1;
    if ((entry.retrieval?.resultCount || 0) === 0) bucket.emptyContextCount += 1;
    bucket.averageContextChars += entry.retrieval?.contextChars || 0;
    bucket.averageSearchLatencyMs += entry.retrieval?.searchLatencyMs || 0;
  }

  for (const bucket of Object.values(byQuestionType)) {
    bucket.accuracy = bucket.total > 0 ? Math.round((bucket.correct / bucket.total) * 10000) / 100 : 0;
    bucket.averageContextChars = bucket.total > 0 ? Math.round((bucket.averageContextChars / bucket.total) * 100) / 100 : 0;
    bucket.averageSearchLatencyMs = bucket.total > 0 ? Math.round((bucket.averageSearchLatencyMs / bucket.total) * 100) / 100 : 0;
  }

  const bottlenecks = {};
  const bottleneckExamples = {};
  const classified = judged.length > 0 ? judged : entries;
  for (const entry of classified) {
    const bottleneck = classifyLongMemEvalBottleneck(entry);
    bottlenecks[bottleneck.type] = (bottlenecks[bottleneck.type] || 0) + 1;
    if (!bottleneckExamples[bottleneck.type]) bottleneckExamples[bottleneck.type] = [];
    if (bottleneckExamples[bottleneck.type].length < 3) {
      bottleneckExamples[bottleneck.type].push({
        question_id: entry.question_id,
        question_type: entry.question_type,
        reason: bottleneck.reason
      });
    }
  }

  const classifiedTotal = classified.length || 1;
  const topBottlenecks = Object.entries(bottlenecks)
    .map(([type, count]) => ({
      type,
      count,
      share: Math.round((count / classifiedTotal) * 1000) / 10,
      examples: bottleneckExamples[type] || []
    }))
    .sort((a, b) => {
      if (a.type === 'healthy' && b.type !== 'healthy') return 1;
      if (b.type === 'healthy' && a.type !== 'healthy') return -1;
      if (b.count !== a.count) return b.count - a.count;
      return a.type.localeCompare(b.type);
    });

  return {
    totalQuestions: total,
    answerableQuestions: answerable,
    abstentionQuestions: abstention,
    judgedQuestions: judgedSummary.judged,
    judgedAccuracy: judgedSummary.accuracy,
    judgedCorrect: judgedSummary.correct,
    retrieval,
    byQuestionType,
    bottlenecks: {
      counts: bottlenecks,
      top: topBottlenecks
    }
  };
}

function buildLongMemEvalReport({
  phase,
  dataPath,
  totalDatasetSize,
  sample,
  startFrom,
  instances,
  records,
  ingestion = null,
  timings = {},
  judgeFile = null,
  runConfig = null
}) {
  const summary = summarizeEntries(records);
  const judgedRecords = records.filter(entry => typeof entry.autoeval_label === 'string');
  const judgedAccuracy = summary.judgedQuestions > 0
    ? Math.round((summary.judgedCorrect / summary.judgedQuestions) * 10000) / 100
    : 0;

  const failedExamples = judgedRecords
    .filter(entry => entry.autoeval_label !== 'yes')
    .slice(0, 10)
    .map(entry => ({
      question_id: entry.question_id,
      question_type: entry.question_type,
      isAbstention: entry.isAbstention,
      verdict: entry.autoeval_label,
      bottleneck: classifyLongMemEvalBottleneck(entry).type,
      hypothesis: entry.hypothesis?.slice(0, 160) || ''
    }));

  return {
    schemaVersion: '2026-03-27',
    kind: 'hivemind.longmemeval-benchmark-report',
    generatedAt: new Date().toISOString(),
    phase,
    dataPath,
    datasetSize: totalDatasetSize,
    sample,
    startFrom,
    instanceCount: instances.length,
    benchUser: BENCH_USER,
    benchOrg: BENCH_ORG,
    model: GROQ_MODEL,
    runConfig,
    timings,
    ingestion,
    summary: {
      ...summary,
      judgedAccuracy
    },
    bottlenecks: summary.bottlenecks,
    byQuestionType: summary.byQuestionType,
    failedExamples,
    files: {
      hypotheses: HYPOTHESIS_FILE,
      judged: judgeFile,
      report: LONGMEMEVAL_REPORT_FILE
    }
  };
}

// ── Date parsing ────────────────────────────────────────

function parseLongMemEvalDate(dateStr) {
  if (!dateStr) return null;
  // Convert to ISO for API storage (document_date must be valid date)
  const match = dateStr.match(/^(\d{4})\/(\d{2})\/(\d{2})\s*\([^)]*\)\s*(\d{2}):(\d{2})/);
  if (match) {
    return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00Z`).toISOString();
  }
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Phase 1: Ingest ─────────────────────────────────────

async function ingestInstance(instance, instanceIdx, totalInstances) {
  const { question_id, haystack_sessions, haystack_dates } = instance;
  const totalSessions = haystack_sessions.length;
  let ingested = 0;
  let skipped = 0;

  // Collect all round-level turns for batch bge-m3 embedding
  const benchmarkBatch = [];

  for (let i = 0; i < totalSessions; i++) {
    const session = haystack_sessions[i];
    const sessionDate = parseLongMemEvalDate(haystack_dates[i]);

    // Round-level ingestion: each user+assistant pair becomes its own memory
    for (let j = 0; j < session.length; j += 2) {
      const userTurn = session[j];
      const assistantTurn = session[j + 1];

      if (!userTurn) continue;

      const content = assistantTurn
        ? `User: ${userTurn.content}\nAssistant: ${assistantTurn.content}`
        : `User: ${userTurn.content}`;

      const title = `LME:${question_id}:s${i}:r${j / 2}`;

      // 1. Ingest via HIVEMIND API (SOTA features: MemoryProcessor, observations, fact-augment)
      try {
        await apiCall('POST', '/api/memories', {
          content,
          title,
          tags: ['longmemeval', `qid:${question_id}`, `session:${i}`],
          memory_type: 'event',
          document_date: sessionDate,
          project: `bench/longmemeval/${question_id}`,
          metadata: {
            session_date: sessionDate,
            session_date_raw: haystack_dates[i],
            question_id,
            session_index: i,
            round_index: j / 2,
            benchmark_enrichment_mode: 'facts_only'
          },
          // Fact-augment mode: extract facts and prepend to content for better embeddings,
          // but skip UPDATE/EXTEND relationships that merge distinct conversation turns.
          // Retrieval still uses full engine (Operator Layer + Recall)
          skipPredictCalibrate: true,
          factAugmentOnly: true,
          skip_relationship_classification: true,
          benchmarkEnrichment: true,
        });
        ingested++;
        // Small delay to avoid overwhelming the API + embedding service
        if (ingested % 20 === 0) await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        skipped++;
        if (skipped <= 3) console.warn(`  [skip] ${question_id}:s${i}:r${j / 2}: ${err.message.slice(0, 100)}`);
      }

      // 2. Collect for BENCHMARK collection (bge-m3 embeddings, direct Qdrant)
      benchmarkBatch.push({
        key: `${question_id}_s${i}_r${Math.floor(j / 2)}`,
        content,
        title,
        sessionDate,
        sessionDateRaw: haystack_dates[i],
        sessionIdx: i,
        roundIdx: Math.floor(j / 2),
      });
    }
  }

  // 3. Batch embed with bge-m3 and upsert to BENCHMARK collection
  if (benchmarkBatch.length > 0) {
    try {
      // Embed in batches of 32 to avoid payload limits
      const BATCH_SIZE = 32;
      for (let b = 0; b < benchmarkBatch.length; b += BATCH_SIZE) {
        const batch = benchmarkBatch.slice(b, b + BATCH_SIZE);
        const texts = batch.map(p => p.content);
        const embeddings = await litellmEmbed(texts);

        const points = batch.map((p, idx) => ({
          id: benchmarkPointId(p.key),
          vector: embeddings[idx],
          payload: {
            content: p.content,
            title: p.title,
            question_id,
            session_date: p.sessionDate,
            session_date_raw: p.sessionDateRaw,
            session_idx: p.sessionIdx,
            round_idx: p.roundIdx,
            project: `bench/longmemeval/${question_id}`,
            memory_type: 'event',
            tags: ['longmemeval', `qid:${question_id}`, `session:${p.sessionIdx}`],
          },
        }));

        await benchmarkUpsert(points);
      }
    } catch (err) {
      console.warn(`  [benchmark] bge-m3 upsert failed for ${question_id}: ${err.message.slice(0, 120)}`);
    }
  }

  console.log(`[${instanceIdx + 1}/${totalInstances}] ${question_id}: ${totalSessions} sessions → ${ingested} memories (+ ${benchmarkBatch.length} bge-m3), ${skipped} skipped`);
  return { ingested, skipped };
}

// ── Phase 2: Evaluate ───────────────────────────────────

async function evaluateInstance(instance, runConfig = makeRunConfig()) {
  const { question_id, question, question_type, question_date } = instance;
  const isAbstention = question_id.endsWith('_abs');
  const retrievalPlan = getLongMemEvalRetrievalPlan({ question, questionType: question_type });

  let searchResults;
  let recallResults = null;
  let quickResults = null;
  let benchmarkResults = null;
  let usedGlobalFallback = false;
  const searchStart = Date.now();
  const project = `bench/longmemeval/${question_id}`;
  try {
    // Step 1: Call cognitive-frame for intent-based query rewriting BEFORE bge-m3 search
    let queryIntent = null;
    let rewrittenQueries = [question]; // default: just the original question
    try {
      const frameResult = await apiCall('POST', '/api/cognitive-frame', {
        query: question,
        project,
      });
      queryIntent = frameResult.intent;

      // Rewrite queries based on intent
      if (question_type === 'temporal-reasoning') {
        // For "which happened first, X or Y?" → search for X and Y separately
        const eventMatch = question.match(/(?:first|last|before|after)[,\s]+(?:the\s+)?['"]?(.+?)['"]?\s+or\s+(?:the\s+)?['"]?(.+?)['"]?\s*\?/i);
        if (eventMatch) {
          rewrittenQueries = [question, eventMatch[1].trim(), eventMatch[2].trim()];
        }
        // For "how many days between X and Y?" → search for both events
        const betweenMatch = question.match(/between\s+(?:the\s+)?['"]?(.+?)['"]?\s+(?:and|event)\s+(?:the\s+)?['"]?(.+?)['"]?\s*\?/i);
        if (betweenMatch) {
          rewrittenQueries = [question, betweenMatch[1].trim(), betweenMatch[2].trim()];
        }
      } else if (question_type === 'knowledge-update') {
        rewrittenQueries = [question, question + ' latest update changed'];
      } else if (question_type === 'multi-session') {
        // Extract sub-topics from multi-session questions
        const andParts = question.match(/(?:about|regarding|on)\s+(.+?)\s+and\s+(.+?)[\?\.]|(.+?)\s+and\s+(.+?)(?:\s+(?:that|which|we))/i);
        if (andParts) {
          const part1 = (andParts[1] || andParts[3] || '').trim();
          const part2 = (andParts[2] || andParts[4] || '').trim();
          if (part1 && part2) {
            rewrittenQueries = [question, part1, part2];
          }
        }
      }
    } catch (e) {
      // cognitive-frame failed, use original question — no-op
    }

    // Step 2: Embed ALL rewritten queries and search with each via bge-m3
    try {
      if (!runConfig.useBenchmarkCollection) {
        throw new Error('benchmark collection disabled for this run mode');
      }
      const allBenchmarkResults = [];
      for (const q of rewrittenQueries) {
        const [qVec] = await litellmEmbed([q]);
        const results = await benchmarkSearch(qVec, question_id, 15);
        allBenchmarkResults.push(...results);
      }
      // Dedupe by content
      const seen = new Set();
      const dedupedResults = [];
      for (const r of allBenchmarkResults) {
        const key = (r.content || '').slice(0, 200);
        if (!seen.has(key)) { seen.add(key); dedupedResults.push(r); }
      }
      // For temporal/multi-session questions, ensure all sessions are represented
      if (question_type === 'temporal-reasoning' || question_type === 'multi-session') {
        const sessionIndices = new Set(dedupedResults.map(r => r.session));
        const totalSessions = instance.haystack_sessions?.length || 0;

        for (let s = 0; s < totalSessions; s++) {
          if (!sessionIndices.has(s)) {
            // This session is missing — fetch its memories by session_idx filter
            try {
              const sessionResults = await benchmarkQdrant('POST', `/collections/${BENCHMARK_COLLECTION}/points/scroll`, {
                filter: {
                  must: [
                    { key: 'question_id', match: { value: question_id } },
                    { key: 'session_idx', match: { value: s } }
                  ]
                },
                limit: 10,
                with_payload: true,
                with_vector: false
              });
              const points = sessionResults.result?.points || [];
              for (const p of points) {
                dedupedResults.push({
                  id: p.id,
                  content: p.payload?.content || '',
                  score: 0.5, // lower score since it's a gap-fill
                  title: p.payload?.title || '',
                  date: p.payload?.session_date || p.payload?.document_date || null,
                  project: p.payload?.project || null,
                  session: p.payload?.session_idx,
                  memoryType: p.payload?.memory_type || null,
                  tags: p.payload?.tags || [],
                });
              }
              if (points.length > 0) {
                console.log(`  [benchmark] Gap-filled session ${s} with ${points.length} memories for ${question_id}`);
              }
            } catch (gapErr) {
              console.warn(`  [benchmark] Gap-fill scroll failed for session ${s}: ${gapErr.message?.slice(0, 80)}`);
            }
          }
        }
      }

      benchmarkResults = dedupedResults;
    } catch (err) {
      console.warn(`  [benchmark] bge-m3 search failed for ${question_id}, falling back to server: ${err.message.slice(0, 80)}`);
    }

    // Secondary retrieval: HIVEMIND API for SOTA features (Operator Layer, graph expansion, panorama)
    // These provide intent detection, temporal expansion, and knowledge-update timeline support
    if (runConfig.useServerMemory && question_type === 'temporal-reasoning') {
      recallResults = await apiCall('POST', '/api/recall', {
        query_context: question,
        project,
        max_memories: 15,
      });
      if (!benchmarkResults) {
        quickResults = await apiCall('POST', '/api/search/quick', {
          query: question, project, limit: 20,
        });
      }

    } else if (runConfig.useServerMemory && question_type === 'knowledge-update') {
      quickResults = await apiCall('POST', '/api/search/panorama', {
        query: question, project, limit: 20,
        include_expired: true, include_historical: true,
      });
      recallResults = await apiCall('POST', '/api/recall', {
        query_context: question, project, max_memories: 15,
      });

    } else if (runConfig.useServerMemory && question_type === 'multi-session') {
      recallResults = await apiCall('POST', '/api/recall', {
        query_context: question, project, max_memories: 15,
      });
      if (!benchmarkResults) {
        quickResults = await apiCall('POST', '/api/search/quick', {
          query: question, project, limit: 20,
        });
      }

    } else if (runConfig.useServerMemory) {
      // Single-session types: bge-m3 is primary; only fall back to server if bge-m3 failed
      if (!benchmarkResults) {
        quickResults = await apiCall('POST', '/api/search/quick', {
          query: question, project, limit: 20,
        });
      }
    }

    // Merge: bge-m3 results (primary) + SOTA recall/panorama results (secondary)
    const benchmarkNorm = benchmarkResults || [];
    const recallNorm = recallResults ? normalizeSearchResults(recallResults) : [];
    const quickNorm = quickResults ? normalizeSearchResults(quickResults) : [];

    // bge-m3 results take priority, then recall/panorama results fill gaps
    const sotaResults = mergeRetrievalResults(
      { results: recallNorm },
      { results: quickNorm },
      retrievalPlan.searchLimit
    );

    searchResults = {
      results: mergeRetrievalResults(
        { results: benchmarkNorm },
        { results: sotaResults },
        retrievalPlan.searchLimit
      )
    };
  } catch {
    searchResults = { results: [] };
  }
  const searchLatencyMs = Date.now() - searchStart;

  const projectResults = normalizeSearchResults(searchResults);
  const selectedResults = selectContextResults(searchResults, retrievalPlan.searchLimit);
  const temporalEvidence = isTemporalReasoningQuestion(question, question_type)
    ? extractTemporalEvidence(question, selectedResults)
    : [];
  const temporalAnswer = temporalEvidence.length > 0
    ? answerTemporalQuestion(question, temporalEvidence)
    : null;
  const structuredEvidence = temporalEvidence.length > 0
    ? buildTemporalEvidenceContext(question, temporalEvidence)
    : '';

  const context = buildBenchmarkContext(
    { results: selectedResults },
    { maxItems: retrievalPlan.contextLimit, maxChars: 12000, sortMode: retrievalPlan.contextSortMode || 'score' }
  );

  let hypothesis;
  const generationStart = Date.now();
  try {
    if (temporalAnswer?.confidence >= 0.9) {
      hypothesis = temporalAnswer.answer;
    } else {
      const userPrompt = buildGenerationPrompt({
        context,
        question,
        questionDate: question_date,
        systemHint: retrievalPlan.systemHint,
        structuredEvidence
      });

      // Use LiteLLM (GPT-4o-mini) if configured, else Groq
      if (LITELLM_BASE && LITELLM_KEY) {
        hypothesis = await litellmChat([
          { role: 'user', content: userPrompt },
        ], { maxTokens: 500 });
      } else {
        hypothesis = await groqChat([
          { role: 'user', content: userPrompt },
        ], { maxTokens: 500 });
      }

      // Fallback to Groq llama if empty
      if (!hypothesis || hypothesis.trim().length === 0) {
        console.warn(`  [fallback] ${question_id}: primary model returned empty, trying groq llama`);
        hypothesis = await groqChat([
          { role: 'user', content: userPrompt },
        ], { model: 'llama-3.3-70b-versatile', maxTokens: 500 });
      }
    }
  } catch (err) {
    console.warn(`  [groq-fail] ${question_id}: ${err.message.slice(0, 100)}`);
    hypothesis = "I don't have this information in my memory.";
  }
  const generationLatencyMs = Date.now() - generationStart;

  return {
    question_id,
    question_type,
    isAbstention,
    hypothesis: hypothesis.trim(),
    retrieval: {
      benchmarkMode: runConfig.benchmarkMode,
      route: benchmarkResults
        ? `bge-m3+${retrievalPlan.route}`
        : (recallResults && quickResults ? `${retrievalPlan.route}+quick` : retrievalPlan.route),
      query: question,
      projectResultCount: projectResults.length,
      benchmarkResultCount: benchmarkResults ? benchmarkResults.length : 0,
      recallResultCount: recallResults ? normalizeSearchResults(recallResults).length : 0,
      quickResultCount: quickResults ? normalizeSearchResults(quickResults).length : 0,
      resultCount: normalizeSearchResults(searchResults).length,
      selectedContextCount: selectedResults.length,
      contextChars: context.length,
      searchLatencyMs,
      generationLatencyMs,
      usedGlobalFallback,
      topResults: selectedResults.map((result, index) => ({
        rank: index + 1,
        id: result.id,
        title: result.title,
        score: result.score,
        project: result.project,
        session: result.session,
        memoryType: result.memoryType,
        sourcePlatform: result.sourcePlatform
      })),
      temporalComparatorUsed: !!temporalAnswer,
      temporalEvidenceCount: temporalEvidence.length,
      temporalAnswerMode: temporalAnswer?.mode || (structuredEvidence ? 'compressed_prompt' : 'raw_prompt'),
      temporalCandidates: temporalEvidence.slice(0, 4).map(item => ({
        memoryId: item.memoryId,
        date: item.isoDate,
        matchedTargets: item.matchedTargets,
        hasEventSignal: item.hasEventSignal
      }))
    }
  };
}

// ── Per-question Groq Judge ──────────────────────────────

async function judgeWithGroq(question, groundTruth, hypothesis, questionType) {
  try {
    const answer = typeof groundTruth === 'string' ? groundTruth : JSON.stringify(groundTruth);
    const prompt = `You are evaluating a memory system's answer. Judge whether the hypothesis correctly answers the question based on the expected answer.

Question: ${question}
Expected Answer: ${answer}
System's Answer: ${hypothesis}

Rules:
- "yes" if the system's answer contains the correct information (exact wording not required)
- "yes" if the answer is semantically equivalent even if phrased differently
- "no" if the answer is wrong, missing key information, or says "I don't know" when the answer exists
- For temporal questions: off-by-one day counts are acceptable
- For knowledge-update: only the LATEST version is correct

Respond with ONLY "yes" or "no".`;

    // Always use llama for judging — reasoning models are overkill for yes/no classification
    const rawVerdict = await groqChat([
      { role: 'system', content: 'You are a strict but fair evaluator. Respond with only "yes" or "no".' },
      { role: 'user', content: prompt },
    ], { model: 'llama-3.3-70b-versatile', maxTokens: 5 });

    const verdict = rawVerdict.trim().toLowerCase().startsWith('yes') ? 'yes' : 'no';
    if (verdict === 'no') {
      console.log(`    [judge] Q: ${question.slice(0, 60)}...`);
      console.log(`    [judge] Expected: ${answer.slice(0, 60)}`);
      console.log(`    [judge] Got: ${hypothesis.slice(0, 60)}`);
      console.log(`    [judge] Raw: "${rawVerdict.trim()}"`);
    }
    return verdict;
  } catch (e) {
    console.warn(`    [judge-error] ${e.message?.slice(0, 80)}`);
    return 'error';
  }
}

// ── Cleanup: delete all memories for a question ──────────

async function cleanupInstance(questionId) {
  let totalDeleted = 0;
  try {
    const bulkResult = await apiCall('DELETE', `/api/memories/delete-all?project=${encodeURIComponent(`bench/longmemeval/${questionId}`)}`);
    totalDeleted = (bulkResult.storeDeleted || 0) + (bulkResult.sqlDeleted || 0);
    if (totalDeleted > 0 || bulkResult.remaining === 0) {
      return totalDeleted;
    }

    for (let round = 0; round < 5; round++) {
      const result = await apiCall('GET', `/api/memories?limit=200&project=bench/longmemeval/${questionId}`);
      const memories = result?.memories || [];
      if (memories.length === 0) break;
      for (const m of memories) {
        try { await apiCall('DELETE', `/api/memories/${m.id}`); totalDeleted++; } catch {}
      }
    }
  } catch {}
  return totalDeleted;
}

// ── Per-question streaming pipeline ──────────────────────

async function processInstanceStreaming(instance, instanceIdx, totalInstances, runConfig = makeRunConfig()) {
  const { question_id, question, question_type, answer } = instance;

  // 1. Ingest this question's sessions (project-scoped: bench/longmemeval/{question_id})
  const ingestStart = Date.now();
  const { ingested, skipped } = await ingestInstance(instance, instanceIdx, totalInstances);
  const ingestLatencyMs = Date.now() - ingestStart;

  // 2. Wait for Qdrant indexing + MemoryProcessor LLM calls
  await new Promise(r => setTimeout(r, 3000));

  // 3. Evaluate (retrieve + generate) — search is project-scoped, no cross-question pollution
  const result = await evaluateInstance(instance, runConfig);

  // 4. Judge with Groq (per-question scoring)
  const judgeStart = Date.now();
  const verdict = await judgeWithGroq(question, answer, result.hypothesis, question_type);
  const judgeLatencyMs = Date.now() - judgeStart;

  let cleaned = 0;
  let cleanupLatencyMs = 0;
  if (runConfig.cleanup) {
    const cleanupStart = Date.now();
    cleaned = await cleanupInstance(question_id);
    cleanupLatencyMs = Date.now() - cleanupStart;
  }

  return {
    ...result,
    ingested,
    skipped,
    cleaned,
    autoeval_label: verdict,
    retrieval: {
      ...result.retrieval,
      ingestLatencyMs,
      judgeLatencyMs,
      cleanupLatencyMs
    }
  };
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  HIVEMIND × LongMemEval-S Benchmark Runner  ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  // Load dataset
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`Dataset not found: ${DATA_PATH}`);
    console.error('Run: cd benchmarks/LongMemEval/data && wget https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json');
    process.exit(1);
  }

  console.log('Loading dataset...');
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  let instances = data.slice(opts.startFrom);
  if (opts.sample > 0) instances = instances.slice(0, opts.sample);

  console.log(`Instances: ${instances.length} (of ${data.length} total)`);
  console.log(`Phase: ${opts.phase}`);
  console.log(`Mode: ${opts.benchmarkMode}`);
  console.log(`Cleanup: ${opts.cleanup ? 'enabled' : 'disabled'}`);
  console.log(`API: ${API_BASE}`);
  console.log(`User: ${BENCH_USER}`);
  console.log(`Generation: ${LITELLM_BASE ? LITELLM_MODEL + ' (LiteLLM)' : GROQ_MODEL + ' (Groq)'}`);
  console.log(`Judge: llama-3.3-70b-versatile (Groq)`);
  console.log(`Benchmark: ${BENCHMARK_COLLECTION} collection (${BENCHMARK_EMBED_MODEL} embeddings)`);
  console.log('');

  // Ensure BENCHMARK collection exists for bge-m3 embeddings
  const benchReady = await ensureBenchmarkCollection();
  if (!benchReady) {
    console.warn('[benchmark] BENCHMARK collection unavailable — will use server-only retrieval');
  }
  const runConfig = makeRunConfig(opts, benchReady);

  // Ensure output dir
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let ingestionSummary = null;
  let evaluationRecords = [];
  let judgedRecords = [];

  // ── STREAMING MODE: per-question ingest→evaluate→cleanup ──
  if (opts.phase === 'stream') {
    console.log('═══ Streaming Mode: Per-Question Pipeline ═══');
    console.log('  Each question: ingest → retrieve → generate → cleanup');
    console.log('');
    const startTime = Date.now();
    const hypotheses = [];
    let totalIngested = 0;
    let totalCleaned = 0;

    let totalCorrect = 0;
    let totalJudged = 0;

    for (let i = 0; i < instances.length; i++) {
      const result = await processInstanceStreaming(instances[i], i, instances.length, runConfig);
      hypotheses.push(result);
      totalIngested += result.ingested || 0;
      totalCleaned += result.cleaned || 0;

      if (result.autoeval_label === 'yes') totalCorrect++;
      if (result.autoeval_label === 'yes' || result.autoeval_label === 'no') totalJudged++;

      const icon = result.autoeval_label === 'yes' ? '✅' : (result.autoeval_label === 'no' ? '❌' : '⚠️');
      const runningAcc = totalJudged > 0 ? (totalCorrect / totalJudged * 100).toFixed(1) : '---';
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const contextLen = result.retrieval?.contextChars || 0;

      console.log(`  ${icon} [${i + 1}/${instances.length}] ${result.question_id} (${instances[i].question_type}) | acc=${runningAcc}% (${totalCorrect}/${totalJudged}) | ctx=${contextLen}ch | "${result.hypothesis.slice(0, 45)}..." (${elapsed}s)`);
    }

    // Write JSONL output
    const jsonlContent = hypotheses.map(h => JSON.stringify(h)).join('\n') + '\n';
    fs.writeFileSync(HYPOTHESIS_FILE, jsonlContent, 'utf-8');
    evaluationRecords = hypotheses;

    const duration = ((Date.now() - startTime) / 1000).toFixed(0);
    const finalAcc = totalJudged > 0 ? (totalCorrect / totalJudged * 100).toFixed(1) : '0';
    console.log(`\n══════════════════════════════════════════════════`);
    console.log(`  Streaming complete: ${hypotheses.length} questions, ${duration}s`);
    console.log(`  Accuracy (Groq judge): ${finalAcc}% (${totalCorrect}/${totalJudged})`);
    console.log(`  Memories: ${totalIngested} ingested, ${totalCleaned} cleaned`);
    console.log(`  Output: ${HYPOTHESIS_FILE}`);
    console.log(`══════════════════════════════════════════════════`);
    console.log('');

    ingestionSummary = { totalIngested, totalSkipped: 0, durationSeconds: Number(duration) };

    // Print question type distribution
    const byType = {};
    for (const inst of instances) {
      const type = inst.question_type;
      byType[type] = (byType[type] || 0) + 1;
    }
    console.log('Question type distribution:');
    for (const [type, count] of Object.entries(byType)) {
      console.log(`  ${type}: ${count}`);
    }

    const evaluationReport = buildLongMemEvalReport({
      phase: 'stream',
      dataPath: DATA_PATH,
      totalDatasetSize: data.length,
      sample: opts.sample,
      startFrom: opts.startFrom,
      instances,
      records: evaluationRecords,
      ingestion: ingestionSummary,
      timings: { totalSeconds: Number(duration) },
      runConfig
    });
    fs.writeFileSync(LONGMEMEVAL_REPORT_FILE, JSON.stringify(evaluationReport, null, 2), 'utf-8');
    console.log(`Partial report: ${LONGMEMEVAL_REPORT_FILE}`);
    console.log('\n═══ Done ═══');
    return;
  }

  // ── Ingest Phase (batch mode — original) ──
  if (['ingest', 'both', 'all'].includes(opts.phase)) {
    console.log('═══ Phase 1: Ingestion ═══');
    const startTime = Date.now();
    let totalIngested = 0;
    let totalSkipped = 0;

    for (let i = 0; i < instances.length; i++) {
      const { ingested, skipped } = await ingestInstance(instances[i], i, instances.length);
      totalIngested += ingested;
      totalSkipped += skipped;

      // Rate limiting: small pause between instances
      if (i % 10 === 9) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = (totalIngested / (Date.now() - startTime) * 1000).toFixed(1);
        console.log(`  ... ${i + 1}/${instances.length} done, ${totalIngested} memories, ${rate}/sec, ${elapsed}s elapsed`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`\nIngestion complete: ${totalIngested} memories, ${totalSkipped} skipped, ${duration}s`);
    console.log('');

    ingestionSummary = {
      totalIngested,
      totalSkipped,
      durationSeconds: Number(duration)
    };
  }

  // ── Evaluate Phase ──
  if (['evaluate', 'both', 'all'].includes(opts.phase)) {
    console.log('═══ Phase 2: Evaluation ═══');
    const startTime = Date.now();
    const hypotheses = [];

    for (let i = 0; i < instances.length; i++) {
      const result = await evaluateInstance(instances[i], runConfig);
      hypotheses.push(result);

      if ((i + 1) % 10 === 0 || i === instances.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`  [${i + 1}/${instances.length}] ${result.question_id}: "${result.hypothesis.slice(0, 60)}..." (${elapsed}s)`);
      }
    }

    // Write JSONL output
    const jsonlContent = hypotheses.map(h => JSON.stringify(h)).join('\n') + '\n';
    fs.writeFileSync(HYPOTHESIS_FILE, jsonlContent, 'utf-8');
    evaluationRecords = hypotheses;

    const duration = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`\nEvaluation complete: ${hypotheses.length} hypotheses, ${duration}s`);
    console.log(`Output: ${HYPOTHESIS_FILE}`);
    console.log('');

    // Print summary stats
    const byType = {};
    for (const inst of instances) {
      const type = inst.question_type;
      byType[type] = (byType[type] || 0) + 1;
    }
    console.log('Question type distribution:');
    for (const [type, count] of Object.entries(byType)) {
      console.log(`  ${type}: ${count}`);
    }

    const evaluationReport = buildLongMemEvalReport({
      phase: 'evaluate',
      dataPath: DATA_PATH,
      totalDatasetSize: data.length,
      sample: opts.sample,
      startFrom: opts.startFrom,
      instances,
      records: evaluationRecords,
      ingestion: ingestionSummary,
      timings: {
        evaluationSeconds: Number(duration)
      },
      runConfig
    });
    fs.writeFileSync(LONGMEMEVAL_REPORT_FILE, JSON.stringify(evaluationReport, null, 2), 'utf-8');
    console.log(`Partial report: ${LONGMEMEVAL_REPORT_FILE}`);
  }

  // ── Judge Phase ──
  if (opts.phase === 'judge' || opts.phase === 'all') {
    console.log('═══ Phase 3: LLM-as-Judge (via Groq) ═══');
    // gpt-oss-120b returns empty on yes/no tasks; llama-3.3-70b works correctly as judge
    const JUDGE_MODEL = 'llama-3.3-70b-versatile'; // Reliable for yes/no classification

    if (!fs.existsSync(HYPOTHESIS_FILE)) {
      console.error(`No hypothesis file found: ${HYPOTHESIS_FILE}`);
      console.error('Run --phase evaluate first.');
      process.exit(1);
    }

    const hypotheses = fs.readFileSync(HYPOTHESIS_FILE, 'utf-8')
      .trim().split('\n').map(l => JSON.parse(l));

    // Build lookup from dataset
    const dataLookup = {};
    for (const d of data) dataLookup[d.question_id] = d;

    const results = { total: 0, correct: 0, byType: {} };
    const judged = [];
    const startTime = Date.now();

    for (let i = 0; i < hypotheses.length; i++) {
      const h = hypotheses[i];
      const ref = dataLookup[h.question_id];
      if (!ref) { console.warn(`  [skip] ${h.question_id}: not found in dataset`); continue; }

      const isAbstention = h.question_id.endsWith('_abs');
      const qType = ref.question_type;

      // Build judge prompt (same as official evaluate_qa.py)
      let judgePrompt;
      if (isAbstention) {
        judgePrompt = `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable.\n\nQuestion: ${ref.question}\n\nExplanation: ${ref.answer}\n\nModel Response: ${h.hypothesis}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
      } else if (qType === 'temporal-reasoning') {
        judgePrompt = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Do not penalize off-by-one errors for the number of days.\n\nQuestion: ${ref.question}\n\nCorrect Answer: ${ref.answer}\n\nModel Response: ${h.hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
      } else if (qType === 'knowledge-update') {
        judgePrompt = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. If the response contains some previous information along with an updated answer, consider it correct.\n\nQuestion: ${ref.question}\n\nCorrect Answer: ${ref.answer}\n\nModel Response: ${h.hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
      } else if (qType === 'single-session-preference') {
        judgePrompt = `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response.\n\nQuestion: ${ref.question}\n\nRubric: ${ref.answer}\n\nModel Response: ${h.hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
      } else {
        judgePrompt = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer.\n\nQuestion: ${ref.question}\n\nCorrect Answer: ${ref.answer}\n\nModel Response: ${h.hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
      }

      let verdict = 'no';
      try {
        const judgeResp = await groqChat([
          { role: 'user', content: judgePrompt },
        ], { model: JUDGE_MODEL, maxTokens: 10 });
        verdict = judgeResp.trim().toLowerCase().startsWith('yes') ? 'yes' : 'no';
      } catch (err) {
        console.warn(`  [judge-fail] ${h.question_id}: ${err.message.slice(0, 80)}`);
        // Retry once after 2s
        await new Promise(r => setTimeout(r, 2000));
        try {
          const retryResp = await groqChat([{ role: 'user', content: judgePrompt }], { model: JUDGE_MODEL, maxTokens: 10 });
          verdict = retryResp.trim().toLowerCase().startsWith('yes') ? 'yes' : 'no';
        } catch { /* give up */ }
      }

      const isCorrect = verdict === 'yes';
      results.total++;
      if (isCorrect) results.correct++;

      if (!results.byType[qType]) results.byType[qType] = { total: 0, correct: 0 };
      results.byType[qType].total++;
      if (isCorrect) results.byType[qType].correct++;

      judged.push({ ...h, autoeval_label: verdict, question_type: qType });

      if ((i + 1) % 20 === 0 || i === hypotheses.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const acc = ((results.correct / results.total) * 100).toFixed(1);
        console.log(`  [${i + 1}/${hypotheses.length}] ${acc}% accuracy so far (${elapsed}s)`);
      }

      // Rate limit: small pause
      if (i % 5 === 4) await new Promise(r => setTimeout(r, 500));
    }

    // Write judged results
    const judgedFile = HYPOTHESIS_FILE.replace('.jsonl', '.judged.jsonl');
    fs.writeFileSync(judgedFile, judged.map(j => JSON.stringify(j)).join('\n') + '\n', 'utf-8');
    judgedRecords = judged;

    const duration = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`\n═══ RESULTS ═══`);
    console.log(`Overall: ${results.correct}/${results.total} = ${((results.correct / results.total) * 100).toFixed(1)}%`);
    console.log('');
    console.log('By category:');
    for (const [type, stats] of Object.entries(results.byType).sort((a, b) => a[0].localeCompare(b[0]))) {
      const pct = ((stats.correct / stats.total) * 100).toFixed(1);
      console.log(`  ${type}: ${stats.correct}/${stats.total} = ${pct}%`);
    }
    console.log(`\nDuration: ${duration}s`);
    console.log(`Judged output: ${judgedFile}`);

    const finalReport = buildLongMemEvalReport({
      phase: opts.phase === 'all' ? 'all' : 'judge',
      dataPath: DATA_PATH,
      totalDatasetSize: data.length,
      sample: opts.sample,
      startFrom: opts.startFrom,
      instances,
      records: judgedRecords.length > 0 ? judgedRecords : hypotheses,
      ingestion: ingestionSummary,
      timings: {
        judgeSeconds: Number(duration)
      },
      judgeFile: judgedFile,
      runConfig
    });
    fs.writeFileSync(LONGMEMEVAL_REPORT_FILE, JSON.stringify(finalReport, null, 2), 'utf-8');
    console.log(`Report: ${LONGMEMEVAL_REPORT_FILE}`);
  }

  console.log('\n═══ Done ═══');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

export {
  normalizeSearchResult,
  normalizeSearchResults,
  selectContextResults,
  mergeRetrievalResults,
  buildGenerationPrompt,
  extractTemporalEvidence,
  answerTemporalQuestion,
  buildTemporalEvidenceContext,
  looksLikeAbstention,
  classifyLongMemEvalBottleneck,
  summarizeEntries,
  buildLongMemEvalReport,
  evaluateInstance,
  ingestInstance,
  parseLongMemEvalDate,
  parseArgs,
  makeRunConfig
};

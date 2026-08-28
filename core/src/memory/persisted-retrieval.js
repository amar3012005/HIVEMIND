import { computeTokenSimilarity, tokenCountMap, cosineFromCounts } from './conflict-detector.js';
import { normalizeEntity } from './entity-normalize.js';
import { resolveEntityRecallCandidates } from './entity-hop0.js';
import { getQdrantClient } from '../vector/qdrant-client.js';
import { runWithOrg, currentOrg, currentApiKey } from '../db/prisma.js';
import { getRetrievalConfig } from './retrieval-config.js';
import { expandTemporalQuery } from '../search/time-aware-expander.js';
import { ResultReranker } from '../search/result-reranker.js';
import { applyExactSourceSummaryPenalty, sortWithImportanceTiebreaker } from './recall-ranking-policy.js';
import { isDurableKbPromotionAdmitted } from './durable-content.js';
import { rerank as crossEncoderRerank } from './reranker.js';
import { meterTokens } from '../billing/usage-tracker.js';
import { isMemoryInDateRange } from './temporal-range.js';
import { memoryBackend } from '../vector/mneme/driver.js';
import { matchesMemoryAccess } from './memory-access.js';

// PHASE-B: single canonical ALGORITHMIC reranker, shared with three-tier-retrieval.js.
// Lazily constructed inside the RECALL_TIERED_VIEW=true branch so the dark-by-default
// contract holds even if ResultReranker's constructor ever gains side effects.
let _algorithmicReranker = null;

// PHASE-B: tiered "recall spine" view (l2_principles / l1_summaries / supporting_facts /
// evidence / bridges) is additive and dark by default. When OFF the result object is
// byte-identical to the legacy shape (no `spine` key, no algorithmic rerank of `top`).
// Default ON (opt-out via RECALL_TIERED_VIEW=false): the wide-window term-
// overlap ResultReranker lifts Solvis fine-detail recall@8 0.80→0.90 + MRR
// 0.51→0.78 with NO network call. The cross-encoder (cross_rerank) stays
// opt-IN — it only adds ~0.02 MRR here, costs 1.5s, and dropped evidence recall.
const TIERED_VIEW_ENABLED = process.env.RECALL_TIERED_VIEW !== 'false';

// PHASE-A: principle-layer recall boost. OFF by default — when unset the `principle`
// role/tag branches below are never taken, so output is byte-identical to legacy.
const PRINCIPLES_RECALL_ENABLED = process.env.PRINCIPLES_ENABLED !== 'false';

function safeRecallText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try { return JSON.stringify(value); } catch { return ''; }
}

// TARA voice activity (turn/insight/call-log/session) is isolated from recall.
// Matches by project prefix `tara/` or any `tara-*` tag.
function isTaraActivity(memory) {
  if (!memory) return false;
  if ((memory.project || '').startsWith('tara/')) return true;
  const t = memory.tags || [];
  return t.some((x) => typeof x === 'string' && (x === 'tara-turn' || x === 'tara-insight' || x === 'tara-call-log' || x === 'tara-session'));
}

// Governance audit-reflection rows + HyperAgents room decisions are operational
// noise, not user knowledge — keep them out of recall candidates. NOTE: the
// 'cognition-loop' tag is deliberately NOT here — the GOOD cognitive-layer
// synthesis/canonical outputs carry it; 'internal-audit'/'governance'/
// 'reflection' are the clean discriminators (0 on synthesis outputs).
function isRecallNoise(memory) {
  if (!memory) return false;
  // Evidence-only rows (e.g. meeting transcripts) ground by id but must NOT
  // compete in semantic top-k. Honoured via explicit metadata flag set at
  // ingest, plus the meeting 'transcript' tag as a belt-and-braces guard.
  if (memory.metadata?.recall_exclude === true) return true;
  const t = memory.tags || [];
  if (t.includes('transcript')) return true;
  return t.some((x) => typeof x === 'string' && (
    x === 'internal-audit' || x === 'governance' || x === 'reflection' ||
    x === 'hyper-rooms' || x === 'hyper-room' || x === 'room-decision'
  ));
}

function scopeChain(ast = {}) {
  if (Array.isArray(ast.scopeChain)) return ast.scopeChain;
  if (typeof ast.scopeChain === 'string' && ast.scopeChain.trim()) return [ast.scopeChain];
  return [];
}

function keywordScore(memory, query = '') {
  if (!query) return 0;
  const lowered = query.toLowerCase();
  const tokens = lowered.split(/\s+/).filter(Boolean);
  const ast = memory.metadata?.ast_metadata || {};
  const content = safeRecallText(memory.content);
  const haystack = [
    content,
    memory.project || '',
    memory.source || '',
    ...(memory.tags || []),
    ...scopeChain(ast),
    ast.signature || '',
    ...(ast.imports || [])
  ].join(' ').toLowerCase();

  const direct = haystack.includes(lowered) ? 2 : 0;
  const tokenHits = tokens.filter(token => haystack.includes(token)).length;

  // Proper noun boost: if query has capitalized words (entities like "SOLVIS", "DaVinci"),
  // check if the memory contains that exact entity (case-sensitive).
  // This prevents "SOLVIS owner" from returning generic heating content.
  let entityBoost = 0;
  const entityWords = query.split(/\s+/).filter(w => w.length > 2 && (w === w.toUpperCase() || /^[A-Z][a-z]/.test(w)));
  for (const entity of entityWords) {
    if (content.includes(entity)) entityBoost += 3;
  }

  return direct + tokenHits + entityBoost;
}

function sortByRelevance(memories, query) {
  return memories
    .map(memory => ({ memory, score: keywordScore(memory, query) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return new Date(right.memory.created_at) - new Date(left.memory.created_at);
    });
}

function normalizeForDedup(content = '') {
  return content
    .toLowerCase()
    .replace(/[`*_>#-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(content = '') {
  return new Set(
    normalizeForDedup(content)
      .split(' ')
      .filter(token => token.length >= 3)
  );
}

function overlapMinRatio(left, right) {
  if (!left || !right || left.size === 0 || right.size === 0) return 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  let overlap = 0;
  for (const token of smaller) {
    if (larger.has(token)) overlap += 1;
  }
  return overlap / smaller.size;
}
function lexicalCoverage(leftContent = '', rightContent = '') {
  return overlapMinRatio(tokenSet(leftContent), tokenSet(rightContent));
}
// Per-candidate memoization for the O(n²) dedup pass: tokenize each candidate's
// content ONCE (the slow \p{L}\p{N} unicode regex + the sim count-map), cache it
// on the item object, reuse across ALL pairwise comparisons. The dedup loop was
// re-tokenizing both sides up to 4× per pair → ~1s of the warm recall. Same
// tokens, same formulas, ~120× fewer tokenizations on a wide pool.
function memoTokenSet(item) {
  if (!item._dedupTokSet) item._dedupTokSet = tokenSet(item.memory?.content || '');
  return item._dedupTokSet;
}
function memoSimCounts(item) {
  if (!item._dedupSimCounts) item._dedupSimCounts = tokenCountMap(item.memory?.content || '');
  return item._dedupSimCounts;
}

function tagOverlapRatio(leftTags = [], rightTags = []) {
  const left = new Set(leftTags);
  const right = new Set(rightTags);
  if (left.size === 0 || right.size === 0) return 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  let overlap = 0;
  for (const tag of smaller) {
    if (larger.has(tag)) overlap += 1;
  }
  return overlap / smaller.size;
}

function isNearDuplicate(left, right) {
  // Memoized: cosineFromCounts(cached count-maps) === computeTokenSimilarity(content,content);
  // overlapMinRatio(cached token-sets) === lexicalCoverage(content,content). Same result, no re-tokenize.
  const similarity = cosineFromCounts(memoSimCounts(left), memoSimCounts(right));
  if (similarity >= 0.85) return true;

  // Extracted facts with same title prefix are likely duplicates from chunked documents
  const leftTitle = (left.memory.title || '').slice(0, 40);
  const rightTitle = (right.memory.title || '').slice(0, 40);
  if (leftTitle && leftTitle === rightTitle && similarity >= 0.60) return true;

  // Same score AND similar content = likely duplicate from same source
  if (Math.abs((left.score || 0) - (right.score || 0)) < 0.01 && similarity >= 0.70) return true;

  const sameSourcePlatform = (left.memory.source_metadata?.source_platform || left.memory.source)
    && (left.memory.source_metadata?.source_platform || left.memory.source) === (right.memory.source_metadata?.source_platform || right.memory.source);
  const coverage = overlapMinRatio(memoTokenSet(left), memoTokenSet(right));
  const tagOverlap = tagOverlapRatio(left.memory.tags || [], right.memory.tags || []);
  if (sameSourcePlatform && tagOverlap >= 0.5 && coverage >= 0.60) return true;

  return false;
}

function richnessScore(memory) {
  return (memory.content?.length || 0) + (memory.tags?.length || 0) * 25 + (memory.title ? 50 : 0);
}

function preferCandidate(left, right) {
  if (right.score !== left.score) return right.score > left.score ? right : left;
  const leftRichness = richnessScore(left.memory);
  const rightRichness = richnessScore(right.memory);
  if (rightRichness !== leftRichness) return rightRichness > leftRichness ? right : left;
  return new Date(right.memory.created_at) > new Date(left.memory.created_at) ? right : left;
}

function temporalAnchor(memory = {}) {
  return memory.metadata?.session_date || memory.document_date || memory.created_at || null;
}

function isTemporalComparisonQuery(query = '') {
  return /\b(first|earlier|earliest|before|after|later|last|how many days|which .* first|which .* came first)\b/i.test(query);
}

// Bi-temporal / time-travel intent: questions about how a fact CHANGED, what it
// USED TO be, its version history, or its state AS OF a past point. When matched,
// recall opens the version-chain (Updates / bi-temporal) lane so the answer can
// reflect history + supersession, not just the current value. Gated → for normal
// queries this returns false and the lane never runs (zero added latency).
function detectTimeTravelIntent(query = '') {
  if (typeof query !== 'string' || !query) return false;
  return /\b(used to be|previously|earlier version|prior version|history of|change[ds]? over time|how (?:has|did|have) .*(?:change|evolve|differ)|evolution of|back (?:in|then)|at the time|as of\b|what (?:was|were|did) .*(?:before|then|originally|used to)|no longer|originally|version history|over the years|timeline of|track .* over time|when did .* change)\b/i.test(query);
}

function normalizedQueryTokens(query = '') {
  return normalizeForDedup(query)
    .split(' ')
    .filter(token => token.length >= 3);
}

function temporalQueryEntities(query = '') {
  const quoted = Array.from(query.matchAll(/"([^"]+)"/g)).map(match => normalizeForDedup(match[1]));
  const eventPhrases = Array.from(query.matchAll(/\b(?:the|a|an)\s+([a-z0-9][a-z0-9' -]{1,60}?(?:workshop|webinar|meeting|trip|vacation|conference|phone|tablet|device|bike|car))\b/gi))
    .map(match => normalizeForDedup(match[1]));
  return [...new Set([...quoted, ...eventPhrases])].filter(Boolean);
}

function temporalSignalBoost(memory = {}, query = '', temporalComparison = false) {
  if (!temporalComparison) return 0;

  const content = normalizeForDedup(memory.content || '');
  const title = normalizeForDedup(memory.title || '');
  const haystack = `${title} ${content}`.trim();
  const entities = temporalQueryEntities(query);
  const tokens = normalizedQueryTokens(query);
  const hasExplicitDate = Boolean(temporalAnchor(memory));
  const hasEventSignal = /\b(attended|joined|bought|purchased|scheduled|met|went|prepared|preparing|participated|ordered|got)\b/i.test(memory.content || '')
    || /\b(workshop|webinar|meeting|trip|vacation|conference|phone|tablet|device|bike|car)\b/i.test(memory.content || '');

  let boost = 0;

  for (const entity of entities) {
    if (entity && haystack.includes(entity)) {
      boost += 0.14;
    }
  }

  if (tokens.length > 0) {
    const overlap = tokens.filter(token => haystack.includes(token)).length;
    boost += Math.min(overlap * 0.015, 0.12);
  }

  if (hasExplicitDate) boost += 0.12;
  if (hasEventSignal) boost += 0.10;

  return Math.min(boost, 0.45);
}

function collapseNearDuplicates(scored, options = {}) {
  const { preserveTemporalDistinctness = false } = options;
  const unique = [];
  const seenNormalized = new Map();

  for (const candidate of scored) {
    const normalized = normalizeForDedup(candidate.memory.content || '');
    const exactMatch = normalized ? seenNormalized.get(normalized) : null;

    if (exactMatch) {
      const preferred = preferCandidate(exactMatch, candidate);
      if (preferred !== exactMatch) {
        const index = unique.indexOf(exactMatch);
        if (index >= 0) unique[index] = preferred;
        seenNormalized.set(normalized, preferred);
      }
      continue;
    }

    let duplicateIndex = -1;
    for (let index = 0; index < unique.length; index += 1) {
      const existing = unique[index];
      if (preserveTemporalDistinctness) {
        const existingAnchor = temporalAnchor(existing.memory);
        const candidateAnchor = temporalAnchor(candidate.memory);
        if (existingAnchor && candidateAnchor && existingAnchor !== candidateAnchor) {
          continue;
        }
      }
      if (isNearDuplicate(existing, candidate)) {
        duplicateIndex = index;
        const preferred = preferCandidate(existing, candidate);
        unique[index] = preferred;
        if (normalized) {
          seenNormalized.set(normalized, preferred);
        }
        break;
      }
    }

    if (duplicateIndex === -1) {
      unique.push(candidate);
      if (normalized) {
        seenNormalized.set(normalized, candidate);
      }
    }
  }

  return unique;
}

export function applyRecallRelevanceFloor(scored, options = {}) {
  const { temporalComparison = false, semanticRecovery = false } = options;
  if (scored.length === 0) return [];

  // Hard absolute minimum — never return results below these thresholds
  const HARD_MIN_SCORE = 0.15;
  const HARD_MIN_SIMILARITY = 0.10;

  // First pass: enforce hard minimum (no exceptions)
  const viable = scored.filter(item =>
    item.score >= HARD_MIN_SCORE &&
    (item.similarityScore ?? item.keywordScore ?? 0) >= HARD_MIN_SIMILARITY
  );

  // If nothing passes hard minimum, return empty — the LLM should say "I don't know"
  if (viable.length === 0) {
    // One bounded recovery attempt may keep a small semantic rerank pool even
    // when legacy weighted scores miss their hard floor. The caller forces the
    // multilingual cross-encoder on this pool; no keyword/type heuristic is
    // re-enabled, and ordinary recall retains the fail-closed empty result.
    return semanticRecovery ? scored.slice(0, 24) : [];
  }

  // Second pass: relative floor based on top score (quality gradient)
  const topScore = viable[0].score;
  const topSimilarity = viable[0].similarityScore ?? 0;
  const minimumScore = temporalComparison
    ? Math.max(topScore * 0.20, HARD_MIN_SCORE)
    : Math.max(topScore * 0.30, HARD_MIN_SCORE);
  const minimumSimilarity = temporalComparison
    ? Math.max(topSimilarity * 0.25, HARD_MIN_SIMILARITY)
    : Math.max(topSimilarity * 0.40, HARD_MIN_SIMILARITY);

  const filtered = viable.filter(item =>
    item.score >= minimumScore &&
    (item.similarityScore ?? 0) >= minimumSimilarity
  );

  return filtered.length > 0 ? filtered : viable.slice(0, temporalComparison ? 5 : 3);
}

/**
 * Memory type boosting based on query intent.
 * Inspired by code-review-graph's kind boosting (PascalCase → Class, snake_case → Function).
 * "what did I decide" → boost decision memories. "my preference" → boost preference memories.
 */
function detectMemoryTypeBoost(query) {
  const q = (query || '').toLowerCase();
  const boosts = {};

  if (/\b(decid|decision|chose|chose|agreed|approved)\b/.test(q)) boosts.decision = 1.6;
  if (/\b(prefer|preference|like|dislike|favorite|rather)\b/.test(q)) boosts.preference = 1.6;
  if (/\b(learn|lesson|mistake|takeaway|insight)\b/.test(q)) boosts.lesson = 1.5;
  if (/\b(goal|plan|target|objective|aim|ambition)\b/.test(q)) boosts.goal = 1.5;
  if (/\b(event|meeting|call|conference|happened|attended)\b/.test(q)) boosts.event = 1.4;
  if (/\b(fact|know|information|detail|data)\b/.test(q)) boosts.fact = 1.3;

  return boosts;
}

function mergeCandidateLists(...lists) {
  // Weighted max-score merge: for each memory, keep the highest score from any list.
  // RRF was tested but performed worse on freeform text memories — rank-based fusion
  // discards semantic signal from vector scores that matters for long-form content.
  const merged = new Map();

  for (const list of lists) {
    for (const item of list || []) {
      if (!item?.memory?.id) continue;
      const existing = merged.get(item.memory.id);
      if (!existing) {
        merged.set(item.memory.id, { ...item });
        continue;
      }

      merged.set(item.memory.id, {
        ...existing,
        memory: existing.memory || item.memory,
        vectorScore: Math.max(existing.vectorScore || 0, item.vectorScore || 0),
        keywordScore: Math.max(existing.keywordScore || 0, item.keywordScore || 0),
        graphScore: Math.max(existing.graphScore || 0, item.graphScore || 0),
        policyScore: Math.max(existing.policyScore || 0, item.policyScore || 0),
        similarityScore: Math.max(existing.similarityScore || 0, item.similarityScore || 0),
        recencyScore: Math.max(existing.recencyScore || 0, item.recencyScore || 0),
        score: Math.max(existing.score || 0, item.score || 0)
      });
    }
  }

  return Array.from(merged.values());
}

function buildRelationshipIndex(relationships) {
  const counts = new Map();
  for (const edge of relationships) {
    counts.set(edge.from_id, (counts.get(edge.from_id) || 0) + 1);
    counts.set(edge.to_id, (counts.get(edge.to_id) || 0) + 1);
  }
  return counts;
}

// WS2 — late-evidence / poisoned-preference fix.
//
// Edge creators whose timestamp reflects WHEN THE STATEMENT WAS MADE (the user
// just said it). Background scanners carry scan-time, so a freshly-scanned old
// contradiction must NOT be treated as "just corrected".
const STATEMENT_TIME_CREATORS = new Set([
  'memory_processor', 'conflict-detector', 'turing-reconciliation', 'turing',
  'entity_co_mention_llm', 'ingest_tree',
]);
// NOTE: 'system' (default/legacy, unknown provenance) is deliberately EXCLUDED
// → it gets the flat 0.60 fallback, not the fresh-statement hard demote/boost.
const CORRECTION_HALFLIFE_DAYS = Number(process.env.CORRECTION_HALFLIFE_DAYS || 14);

// Map<to_id, {createdBy, _ts}> — the NEWEST Contradicts edge targeting each
// memory. A memory the graph flagged as contradicted should rarely beat its
// successor; how hard we demote depends on how fresh the contradiction is.
function buildContradictedIndex(relationships) {
  const map = new Map();
  for (const edge of relationships) {
    if (edge.type !== 'Contradicts' || !edge.to_id) continue;
    const ts = edge.created_at ? new Date(edge.created_at).getTime() : 0;
    const prev = map.get(edge.to_id);
    if (!prev || ts > prev._ts) map.set(edge.to_id, { createdBy: edge.created_by, _ts: ts });
  }
  return map;
}

// Map<from_id, _ts> — a memory that is the SOURCE of a recent statement-time
// Contradicts/Updates edge is the later-stated ("winning") memory.
function buildCorrectionWinnerIndex(relationships) {
  const map = new Map();
  for (const edge of relationships) {
    if ((edge.type !== 'Contradicts' && edge.type !== 'Updates') || !edge.from_id) continue;
    if (!STATEMENT_TIME_CREATORS.has(edge.created_by)) continue;
    const ts = edge.created_at ? new Date(edge.created_at).getTime() : 0;
    if (ts > (map.get(edge.from_id) || 0)) map.set(edge.from_id, ts);
  }
  return map;
}

// Temporal contradiction penalty. Fresh statement-time contradiction → 0.40
// (hard demote); decays toward 0.90 (soft) as the edge ages past the halflife.
// Non-statement (scanner/system) edges → flat 0.60 (moderate, not "just said").
function contradictionPenalty(info, nowMs) {
  if (!info) return 1;
  if (!STATEMENT_TIME_CREATORS.has(info.createdBy)) return 0.60;
  const ageDays = info._ts ? Math.max(0, (nowMs - info._ts) / 86400000) : 9999;
  const frac = Math.min(ageDays / CORRECTION_HALFLIFE_DAYS, 1);
  return Math.min(Math.max(0.40 + 0.50 * frac, 0.40), 0.90);
}

// Correction-winner boost: the later-stated memory floats up. 1.0→1.20 by recency.
function correctionWinnerBoost(winnerTs, nowMs) {
  if (!winnerTs) return 1;
  const ageDays = Math.max(0, (nowMs - winnerTs) / 86400000);
  return 1 + 0.20 * (1 - Math.min(ageDays / CORRECTION_HALFLIFE_DAYS, 1));
}

function policyBoost(memory, {
  preferred_project = null,
  preferred_source_platforms = [],
  preferred_tags = []
}) {
  let score = 0;
  if (preferred_project && memory.project === preferred_project) {
    score += 0.15;
  }

  const sourcePlatform = memory.source_metadata?.source_platform || memory.source || null;
  if (preferred_source_platforms.includes(sourcePlatform)) {
    score += 0.12;
  }

  if (preferred_tags.length > 0) {
    score += tagOverlapRatio(memory.tags || [], preferred_tags) * 0.08;
  }

  return score;
}

function isMemoryInTemporalSnapshot(memory, { validAt = null, knownAt = null } = {}) {
  if (!validAt && !knownAt) return true;
  const created = memory?.created_at || memory?.createdAt || null;
  const validFrom = memory?.valid_from || memory?.validFrom
    || memory?.document_date || memory?.documentDate || created;
  const validTo = memory?.valid_to || memory?.validTo || null;
  const createdMs = created ? new Date(created).getTime() : Number.NaN;
  const fromMs = validFrom ? new Date(validFrom).getTime() : Number.NaN;
  const toMs = validTo ? new Date(validTo).getTime() : Number.NaN;
  const validMs = validAt ? new Date(validAt).getTime() : null;
  const knownMs = knownAt ? new Date(knownAt).getTime() : null;

  if (knownMs != null && (!Number.isFinite(createdMs) || createdMs > knownMs)) return false;
  if (validMs != null) {
    if (Number.isFinite(fromMs) && fromMs > validMs) return false;
    if (Number.isFinite(toMs) && toMs <= validMs) return false;
  }
  return true;
}

// Retrieve-wide → deliver-narrow. The candidate pool must stay WIDE regardless
// of how many rows the caller wants delivered — otherwise asking for 8 fetches
// only ~32 candidates, and a relevant row that ranks (say) 40th in a wide pool
// is never even fetched, so MMR/score-floor can't recover it. This starved the
// pool for every small-deliver caller (Tara max=6-8, chat max=8) and was the
// real cause of "exact fact missed at k=8 but rank-1 at k=50". Floor is env-
// tunable; default 150 captures the cross-lingual / long-tail matches.
const RECALL_POOL_CEILING = 150;
const RECALL_POOL_FLOOR = Math.min(
  RECALL_POOL_CEILING,
  Math.max(Number(process.env.RECALL_CANDIDATE_POOL || RECALL_POOL_CEILING), 50),
);

function boundedCandidatePool(maxMemories, multiplier = 4) {
  return Math.min(
    RECALL_POOL_CEILING,
    Math.max(Number(maxMemories || 0) * multiplier, RECALL_POOL_FLOOR),
  );
}

export function boundedLaneFusion(lanes, ceiling = RECALL_POOL_CEILING) {
  const active = lanes.filter((lane) => Array.isArray(lane) && lane.length > 0);
  const fused = [];
  const seen = new Set();
  for (let index = 0; fused.length < ceiling && active.some((lane) => index < lane.length); index += 1) {
    for (const lane of active) {
      const candidate = lane[index];
      if (!candidate) continue;
      const memory = candidate.memory || candidate;
      const id = memory?.id || memory?.memory_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      fused.push(candidate);
      if (fused.length >= ceiling) break;
    }
  }
  return fused;
}

// ── Cross-lingual / sparse-recall query expansion ─────────────────────────
// When the primary vector recall is THIN (few candidates clear the score
// floor — the classic signature of a cross-lingual query: an English question
// over a German corpus scores every row low), a fast LLM proposes alternative
// phrasings / translations that preserve entities + numbers, then we re-fetch
// on those with a relaxed floor and merge. Gated on thin-recall so the rich-
// corpus happy path never pays the LLM cost. Cached, timeout-bounded, graceful.
// Raw recall is a deterministic retrieval primitive. Query understanding belongs
// to /chat's planner; recall-time LLM rewrites are opt-in for controlled
// evaluation only. BGE-M3 already supplies multilingual semantic retrieval.
const QUERY_EXPANSION_ENABLED = process.env.RECALL_QUERY_EXPANSION === 'true';
const EXPAND_MIN_CANDIDATES = Number(process.env.RECALL_EXPAND_MIN || 12);
const _expansionCache = new Map(); // queryKey → string[] variants (bounded)
const _entityLlmCache = new Map(); // queryKey → string[] entity tags (bounded)
// Single fast model for ALL recall-time query understanding (cross-lingual
// rewrite + entity extraction) — llama-3.1-8b-instant on Groq. Token usage is
// metered through the SAME usage-tracker chokepoint as the rest of the system.
const QUERY_LLM_MODEL = process.env.RECALL_EXPANSION_MODEL || 'llama-3.1-8b-instant';

// Shared Groq JSON call with usage metering. Returns parsed object or {}.
async function _groqQueryLLM(systemPrompt, userText, orgId, timeoutMs = 2500) {
  if (!process.env.GROQ_API_KEY) return {};
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: QUERY_LLM_MODEL,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: String(userText).slice(0, 300) }],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return {};
    const j = await r.json();
    if (orgId && j.usage?.total_tokens) meterTokens(orgId, j.usage.total_tokens, currentApiKey(), j.model, 'recall-expansion'); // same usage-tracker pipeline, now per-key attributed
    return JSON.parse(j.choices?.[0]?.message?.content || '{}');
  } catch (e) { return {}; }
}

async function expandQueryMultilingual(query, orgId) {
  if (!query || typeof query !== 'string' || query.trim().length < 4) return [];
  const key = query.trim().toLowerCase();
  if (_expansionCache.has(key)) return _expansionCache.get(key);
  const parsed = await _groqQueryLLM(
    'A search query may be in a different language than the stored documents (often English query over German technical docs). Output STRICT JSON {"variants":["…"]} with up to 2 query rewrites that maximise lexical+semantic overlap with the documents. Rules: (1) FULLY translate EVERY word INCLUDING domain/technical nouns into German — e.g. "chimney sweep"→"Kaminkehrer/Schornsteinfeger", "button"→"Taste", "heat pump"→"Wärmepumpe", "manual mode"→"Handbetrieb"; do NOT leave English domain terms. (2) Keep numbers, units and product names verbatim (SolvisLea, 5). (3) One variant may be a terse keyword list of the translated key nouns. If the query is already plainly in the corpus language, return {"variants":[]}.',
    query, orgId,
  );
  const variants = (Array.isArray(parsed.variants) ? parsed.variants : [])
    .filter((v) => typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== key)
    .slice(0, 2);
  if (_expansionCache.size > 2000) _expansionCache.clear();
  _expansionCache.set(key, variants);
  return variants;
}

// LLM entity extraction (llama-3.1-8b-instant, metered) for the entity-filter
// lane. The regex normalizeQueryEntityTokens misses lowercase / multi-word /
// canonical entity forms, which is why the entity lane measured 0 lift. The LLM
// extracts the canonical entities the way the INGEST side tags them (English,
// singular, full term) → `entity:<name>` tags that actually match the corpus.
// Gated by ENTITY_LLM_EXTRACT; cached + metered + graceful.
async function extractQueryEntitiesLLM(query, orgId) {
  // Canonical entities are resolved from the tenant registry before retrieval.
  // Keep the older LLM extractor available only as an explicit experiment; it
  // must not create a hidden model call inside ordinary /api/recall requests.
  if (process.env.ENTITY_LLM_EXTRACT !== 'true') return [];
  if (!query || typeof query !== 'string' || query.trim().length < 3) return [];
  const key = query.trim().toLowerCase();
  if (_entityLlmCache.has(key)) return _entityLlmCache.get(key);
  const parsed = await _groqQueryLLM(
    'Extract the named entities (people, products, companies, projects, places) a memory search should filter on. Canonical form: English, singular, full term, no honorifics. Output STRICT JSON {"entities":["Amar Sai Gadde","SolvisLea Pro"]}. Empty array if none.',
    query, orgId,
  );
  const out = new Set();
  for (const e of (Array.isArray(parsed.entities) ? parsed.entities : [])) {
    if (typeof e !== 'string' || !e.trim()) continue;
    const us = e.trim().replace(/\s+/g, '_');
    out.add(`entity:${us}`); out.add(`entity:${us.toLowerCase()}`); out.add(`person:${us}`);
  }
  const tags = Array.from(out);
  if (_entityLlmCache.size > 2000) _entityLlmCache.clear();
  _entityLlmCache.set(key, tags);
  return tags;
}

// Scope-filter matcher — the chat scope selector (personal / all-org / project)
// must ACTUALLY restrict the delivered set. The naive `m.scope === scope_filter`
// check fails because several lanes (FTS / lexical / Qdrant-payload) deliver rows
// with NO hydrated `scope`, and `m.scope && …` then keeps every scope-less row —
// so a project fact leaked into a `personal` recall. Infer the tier the SAME way
// the access-context filter does (~L790): a project link ⇒ 'project'; otherwise
// 'organization'. NEVER infer 'personal' — the personal tier requires a proven
// scope row, so the `personal` lens admits ONLY provably-personal memories (a
// scope-less row can't claim it). 'organization'/none is passed as null upstream
// → this is never called for the org-wide lens (everything the access context
// already allows is delivered).
function matchesScopeFilter(m, scope_filter) {
  if (!scope_filter) return true;
  if (!m) return false;
  // Accept BOTH shapes: a flat memory (per-lane checks pass one) AND a ranked
  // wrapper item `{ memory, score, … }` (the post-merge choke point passes one —
  // the flatten to `{...item.memory}` happens later). Reading scope off the
  // wrapper saw undefined and inferred 'organization', silently dropping the
  // whole pool for a project/personal lens.
  const mem = (m.memory && typeof m.memory === 'object') ? m.memory : m;
  const eff = mem.scope
    || ((mem.project_id || (Array.isArray(mem.project_ids) && mem.project_ids.length)) ? 'project' : 'organization');
  return eff === scope_filter;
}

async function vectorCandidatesForRecall(store, {
  query_context,
  query_vector = null,
  user_id,
  org_id,
  project,
  source_platforms = [],
  tags = [],
  max_memories,
  dateRange = null,
  validAt = null,
  knownAt = null,
  scoreThreshold = 0.25,
  hnswEf = undefined, // PHASE-F: per-org HNSW ef_search; undefined → searchMemories falls back to EF_SEARCH_DEFAULT
  candidatePoolSize = boundedCandidatePool(max_memories),
  is_latest = true,
  access_context = null,
  scope_filter = null,
  timing = null,
}) {
  const qdrantClient = getQdrantClient();
  if (memoryBackend(org_id) === 'central') {
    const connected = await qdrantClient.isConnected();
    if (!connected) return [];
  }

  // PHASE-F NOTE: the LIVE /api/recall tuned-param path is
  //   recallPersistedMemories → vectorCandidatesForRecall → qdrantClient.hybridSearch
  //   (src/vector/qdrant-client.js) → searchMemories.
  // It bypasses BOTH src/search/hybrid.js AND src/external/search/hybrid.js entirely.
  // PHASE-X TODO: the genuine hybrid.js dedup (search/ vs external/search/, currently
  // diverged supersets — NOT identical) is DEFERRED. Any future unification MUST preserve
  // the LIVE matchesHardScope scope-filtering in src/search/hybrid.js and the
  // ThreeTierRetrieval path (server.js → three-tier-retrieval.js → ResultReranker).
  const vectorLaneStartedAt = timing ? Date.now() : 0;
  const results = await qdrantClient.hybridSearch(query_context, {
    vector: query_vector,
    user_id,
    org_id,
    // NOTE: do NOT pass `project` as a Qdrant pre-filter. Project-scoped memories
    // carry only `project_id` (uuid) in the DB; their Qdrant payload has
    // `project: null` and `project_ids: []` (never populated from project_id),
    // so a `payload.project == <uuid>` filter matches nothing and silently
    // drops every in-project memory. We instead retrieve org-wide candidates and
    // NARROW to the requested project AFTER hydration using the reliable DB
    // `project_id` (see below). Narrowing-only — it cannot widen access.
    tags,
    is_latest,
    valid_at: validAt,
    known_at: knownAt,
    limit: candidatePoolSize,
    score_threshold: scoreThreshold,
    hnsw_ef: hnswEf, // PHASE-F: inert when undefined (searchMemories → EF_SEARCH_DEFAULT)
    // Per-tenant routing fix: omit explicit collectionName so qdrant-client resolves
    // the org_<id> / HIVEMIND_PERSONAL container from filter.org_id (writes already
    // route this way via createMemory). Previously this forced the legacy
    // 'BUNDB AGENT' collection, which bypassed EVERY per-tenant collection where the
    // real bge-m3 vectors live — recall reads were searching the wrong store.
    collectionName: undefined,
    timing,
  });
  if (timing) timing.vector_lane_ms = (timing.vector_lane_ms || 0) + (Date.now() - vectorLaneStartedAt);

  // Batch-hydrate every candidate id in ONE findMany. Previously this fanned out
  // N concurrent store.getMemory() (findUnique) calls inside Promise.all — under
  // the full recall pipeline's concurrency that slammed the Prisma pool and most
  // returned null, silently collapsing the vector lane from ~150 hits to ~1. The
  // batch is a single query (no contention) and also populates project_ids.
  const _vecIds = (results || []).map(r => r.payload?.memory_id || r.id).filter(Boolean);
  const hydrateStartedAt = timing ? Date.now() : 0;
  const _vecMemById = store.getMemories
    ? await store.getMemories(_vecIds, { valid_at: validAt, known_at: knownAt })
    : new Map();
  if (timing) timing.vector_hydrate_ms = (timing.vector_hydrate_ms || 0) + (Date.now() - hydrateStartedAt);
  const hydrated = (results || []).map(result => {
    const sourcePlatform = result.payload?.source_platform || result.payload?.source || null;
    if (source_platforms.length > 0 && !source_platforms.includes(sourcePlatform)) {
      return null;
    }

    const memoryId = result.payload?.memory_id || result.id;
    const memory = _vecMemById.get(memoryId);
    if (!memory) return null;
    if (typeof is_latest === 'boolean' && (memory.is_latest !== false) !== is_latest) return null;
    if (!isMemoryInDateRange(memory, dateRange)) return null;
    if (!isMemoryInTemporalSnapshot(memory, { validAt, knownAt })) return null;
    // V2 scope filtering: enforce after hydrate (vector index doesn't carry scope)
    if (!matchesMemoryAccess(memory, { userId: user_id, orgId: org_id, accessContext: access_context })) return null;
    // Project-scope narrowing (replaces the broken Qdrant `project` pre-filter):
    // when a specific project is requested, keep only memories that actually
    // belong to it, using the reliable hydrated DB fields. Narrowing-only.
    if (project) {
      const pid = memory.project_id || null;
      const pids = Array.isArray(memory.project_ids) ? memory.project_ids : [];
      if (pid !== project && !pids.includes(project)) return null;
    }
    if (!matchesScopeFilter(memory, scope_filter)) return null;

    return {
      memory,
      vectorScore: result.score || 0,
      keywordScore: 0,
      graphScore: 0,
      policyScore: 0,
      similarityScore: computeTokenSimilarity(query_context || '', memory.content || ''),
      recencyScore: 0,
      score: result.score || 0
    };
  });

  const _vfReturn = hydrated.filter(item => {
    if (!item) return false;
    const mt = item.memory?.tags || [];
    // Exclude benchmark data from production recall when no specific project is set
    if (!project && mt.includes('longmemeval')) return false;
    // Drop cognition-loop canonical-summary nodes from default recall —
    // BUT only the generic chat compactions. Knowledge-base / document /
    // entity-scoped compactions ARE the substantive content (originals
    // get soft-deleted after drift-compaction), so suppressing them
    // blinds the agent to ingested PDFs.
    if (
      !tags.includes('canonical-summary') &&
      mt.includes('canonical-summary') &&
      !mt.some(t => t === 'topic:knowledge-base' || t === 'topic:document' || (typeof t === 'string' && t.startsWith('topic:entity:')))
    ) return false;
    return true;
  });
  if (process.env.RECALL_LAP === 'true') {
    console.log('[vec-funnel]', JSON.stringify({ qdrant_hits: (results || []).length, hydrated_nonnull: hydrated.filter(Boolean).length, after_filter: _vfReturn.length }));
  }
  return _vfReturn;
}

function timelineFor(memory, memoryById, relationships) {
  const lineage = [memory];
  const visited = new Set([memory.id]);
  let current = memory;

  while (current) {
    const previous = relationships.find(edge =>
      edge.type === 'Updates' && edge.from_id === current.id && !visited.has(edge.to_id)
    );
    if (!previous) break;
    const prevMemory = memoryById.get(previous.to_id);
    if (!prevMemory) break;
    lineage.push(prevMemory);
    visited.add(prevMemory.id);
    current = prevMemory;
  }

  return lineage.sort((left, right) => new Date(left.created_at) - new Date(right.created_at));
}

function traversal(startId, relationships, depth = 2, types = ['Derives', 'Extends', 'Updates']) {
  const visited = new Set();
  const queue = [{ id: startId, level: 0 }];
  const nodes = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current.id) || current.level > depth) continue;
    visited.add(current.id);
    nodes.push(current.id);

    for (const edge of relationships) {
      if (!types.includes(edge.type)) continue;
      // Bidirectional: follow edges both outgoing (current → target) and incoming (source → current)
      if (edge.from_id !== current.id && edge.to_id !== current.id) continue;
      const next = edge.from_id === current.id ? edge.to_id : edge.from_id;
      if (!visited.has(next)) queue.push({ id: next, level: current.level + 1 });
    }
  }

  return nodes;
}

export async function queryPersistedMemories(store, opts) {
  // Residency: run in the org's context so hydrate/listMemories hit the org's store (customer PG for
  // a self-host org). Re-entrancy guard; undefined org → central (managed), unchanged.
  if (opts?.org_id && currentOrg() !== opts.org_id) return runWithOrg(opts.org_id, () => queryPersistedMemories(store, opts));
  return _queryPersistedMemoriesImpl(store, opts);
}
async function _queryPersistedMemoriesImpl(store, { pattern, user_id, org_id, project, ...params }) {
  const { memories } = await store.listMemories({
    user_id,
    org_id,
    project,
    is_latest: undefined,
    limit: 5000,
    offset: 0
  });
  const relationships = await store.listRelationships({ user_id, org_id, project, limit: 5000 });
  const memoryById = new Map(memories.map(memory => [memory.id, memory]));
  const active = memories.filter(memory => memory.is_latest !== false);

  switch (pattern) {
    case 'state_of_union': {
      const limit = params.limit || 5;
      return sortByRelevance(active, params.query)
        .slice(0, limit)
        .map(item => ({
          current: item.memory,
          history: timelineFor(item.memory, memoryById, relationships)
        }));
    }
    case 'event_time': {
      const limit = params.limit || 20;
      const exactDate = params.event_date ? new Date(params.event_date) : null;
      const start = params.start_date ? new Date(params.start_date) : null;
      const end = params.end_date ? new Date(params.end_date) : null;

      const filtered = memories.filter(memory => {
        const dates = [memory.document_date, ...(memory.event_dates || [])].filter(Boolean).map(value => new Date(value));
        if (dates.length === 0) return false;
        return dates.some(date => {
          if (exactDate) return date.toISOString().slice(0, 10) === exactDate.toISOString().slice(0, 10);
          if (start && end) return date >= start && date <= end;
          if (start) return date >= start;
          if (end) return date <= end;
          return true;
        });
      });

      return sortByRelevance(filtered, params.query).slice(0, limit).map(item => item.memory);
    }
    case 'refinement': {
      const root = params.root_memory_id
        ? memoryById.get(params.root_memory_id)
        : sortByRelevance(memories, params.query)[0]?.memory;
      if (!root) return null;
      const refinementIds = relationships
        .filter(edge => edge.type === 'Extends' && edge.to_id === root.id)
        .map(edge => edge.from_id);
      return { root, refinements: refinementIds.map(id => memoryById.get(id)).filter(Boolean) };
    }
    case 'inferred_connection': {
      const seedQuery = [params.person, params.topic, params.query].filter(Boolean).join(' ');
      const seeds = sortByRelevance(memories, seedQuery).map(item => item.memory).filter(memory => keywordScore(memory, seedQuery) > 0).slice(0, 5);
      const connected = new Set();
      for (const seed of seeds) {
        for (const id of traversal(seed.id, relationships, params.depth || 2)) {
          if (id !== seed.id) connected.add(id);
        }
      }
      const connections = Array.from(connected).map(id => memoryById.get(id)).filter(Boolean);
      return { seeds, connections: sortByRelevance(connections, seedQuery).map(item => item.memory) };
    }
    case 'structural_implementation': {
      const filtered = memories.filter(memory => {
        const ast = memory.metadata?.ast_metadata;
        if (!ast) return false;
        const filepath = memory.metadata?.filepath || memory.source_metadata?.source_id || memory.source || '';
        const haystack = [ast.signature || '', ...scopeChain(ast), ...(ast.imports || []), filepath].join(' ').toLowerCase();
        const symbolOk = params.symbol ? haystack.includes(params.symbol.toLowerCase()) : true;
        const pathOk = params.filepath ? filepath.includes(params.filepath) : true;
        return symbolOk && pathOk;
      });
      return sortByRelevance(filtered, params.symbol || params.filepath)
        .slice(0, params.limit || 10)
        .map(item => ({
          ...item.memory,
          scope_context: scopeChain(item.memory.metadata?.ast_metadata || {}),
          signature: item.memory.metadata?.ast_metadata?.signature || null
        }));
    }
    case 'impact_analysis': {
      const filtered = memories.filter(memory => {
        const ast = memory.metadata?.ast_metadata;
        if (!ast) return false;
        const imports = ast.imports || [];
        const scopes = scopeChain(ast);
        const signature = ast.signature || '';
        const source = memory.metadata?.filepath || memory.source_metadata?.source_id || memory.source || '';
        const fileHit = params.filepath ? source.includes(params.filepath) || imports.some(item => item.includes(params.filepath)) : false;
        const symbol = (params.symbol || '').toLowerCase();
        const symbolHit = symbol ? signature.toLowerCase().includes(symbol) || scopes.some(item => item.toLowerCase().includes(symbol)) || imports.some(item => item.toLowerCase().includes(symbol)) : false;
        return fileHit || symbolHit;
      });
      return sortByRelevance(filtered, [params.filepath, params.symbol].filter(Boolean).join(' '))
        .slice(0, params.limit || 20)
        .map(item => item.memory);
    }
    case 'evidence': {
      return sortByRelevance(memories, params.query)
        .map(item => item.memory)
        .filter(memory => keywordScore(memory, params.query) > 0)
        .filter(memory => !params.source_type || memory.source_metadata?.source_type === params.source_type)
        .slice(0, params.limit || 10)
        .map(memory => ({
          memory,
          evidence: {
            source: memory.source,
            source_metadata: memory.source_metadata,
            record_time: memory.created_at,
            event_time: memory.document_date || memory.event_dates?.[0] || null
          }
        }));
    }
    case 'cross_platform_thread': {
      const relevant = sortByRelevance(memories, params.query)
        .map(item => item.memory)
        .filter(memory => keywordScore(memory, params.query) > 0)
        .slice(0, params.limit || 20);
      const grouped = relevant.reduce((accumulator, memory) => {
        const sourceType = memory.source_metadata?.source_type || memory.source || 'unknown';
        if (!accumulator[sourceType]) accumulator[sourceType] = [];
        accumulator[sourceType].push(memory);
        return accumulator;
      }, {});
      return { query: params.query, project: project || null, sources: grouped };
    }
    default:
      throw new Error(`Unsupported query pattern: ${pattern}`);
  }
}

/**
 * Expands candidate memories via graph traversal to discover related memories.
 * Fetches related memory details and scores them based on relationship strength and depth.
 *
 * @param {Object} store - Memory store for fetching memory details
 * @param {Object} params - Expansion parameters
 * @param {Array} params.initialCandidates - Initial candidate memories
 * @param {Array} params.relationships - Graph relationships
 * @param {Map} params.relationshipCounts - Relationship count index
 * @param {string} params.query_context - Query context for similarity scoring
 * @param {Object} params.weights - Scoring weights
 * @param {string|null} params.preferred_project - Preferred project for policy boost
 * @param {Array} params.preferred_source_platforms - Preferred platforms for policy boost
 * @param {Array} params.preferred_tags - Preferred tags for policy boost
 * @param {number} params.depth - Graph traversal depth (default: 2)
 * @returns {Array} Expanded candidate memories with graph_expanded flag
 */
async function traverseUpdateChain(memories, store, {
  maxDepth = 3,
  user_id = null,
  org_id = null,
  project = null,
  valid_at = null,
  known_at = null,
} = {}) {
  if (!store || !memories?.length) return memories;

  const expanded = [...memories];
  const seen = new Set(memories.map(m => m.id || m.memory_id));

  // Batch the per-memory Updates-chain lookups CONCURRENTLY (was a serial N+1
  // await loop). Keeps the time-travel lane cheap enough to run by default on
  // history queries without adding serial latency.
  const ids = memories.map(m => m.id || m.memory_id).filter(Boolean);
  const relatedLists = await Promise.all(ids.map(id =>
    Promise.resolve()
      .then(() => store.getRelatedMemories?.(id, {
        relationship: 'Updates',
        maxDepth,
        user_id,
        org_id,
        project,
        scope: 'all',
      }))
      .catch(() => [])
  ));

  // getRelatedMemories returns typed EDGES, not hydrated memories. Collect the
  // peer ids from both directions, then hydrate them in one scoped batch. The
  // previous implementation appended edge objects to the candidate pool, so a
  // version chain appeared traversed while no historical content was present.
  const relatedIds = [];
  for (const edges of relatedLists) {
    for (const edge of (edges || [])) {
      for (const peerId of [edge.from_id, edge.to_id]) {
        if (peerId && !seen.has(peerId)) {
          seen.add(peerId);
          relatedIds.push(peerId);
        }
      }
    }
  }
  if (relatedIds.length) {
    const hydrated = store.getMemories
      ? await store.getMemories(relatedIds, { valid_at, known_at })
      : new Map();
    for (const relId of relatedIds) {
      const memory = hydrated.get(relId);
      if (memory) expanded.push({ ...memory, score: (memory.score || 0) * 0.7 });
    }
  }

  return expanded;
}

async function expandCandidatesViaGraph(store, {
  initialCandidates,
  relationships,
  relationshipCounts,
  query_context,
  weights,
  preferred_project,
  preferred_source_platforms,
  preferred_tags,
  depth = 2
}) {
  const expandedMemoryIds = new Set(initialCandidates.map(c => c.memory?.id).filter(Boolean));
  const expandedCandidates = [];
  const relationshipTypes = ['Updates', 'Contradicts', 'Derives', 'PartOf', 'Extends'];
  const edgePriority = { Updates: 5, Contradicts: 4, Derives: 3, PartOf: 2, Extends: 1 };

  // Build relationship lookup for quick access to edge metadata
  const relationshipLookup = new Map();
  for (const edge of relationships) {
    const key = `${edge.from_id}-${edge.to_id}`;
    const current = relationshipLookup.get(key);
    if (!current
      || (edgePriority[edge.type] || 0) > (edgePriority[current.type] || 0)
      || ((edgePriority[edge.type] || 0) === (edgePriority[current.type] || 0)
        && Number(edge.confidence || 0) > Number(current.confidence || 0))) {
      relationshipLookup.set(key, edge);
    }
    const reverseKey = `${edge.to_id}-${edge.from_id}`;
    const reverseCurrent = relationshipLookup.get(reverseKey);
    if (!reverseCurrent
      || (edgePriority[edge.type] || 0) > (edgePriority[reverseCurrent.type] || 0)
      || ((edgePriority[edge.type] || 0) === (edgePriority[reverseCurrent.type] || 0)
        && Number(edge.confidence || 0) > Number(reverseCurrent.confidence || 0))) {
      relationshipLookup.set(reverseKey, edge);
    }
  }

  // Track relationship paths for scoring
  const relationshipPaths = new Map();

  // PASS 1 (sync): walk the graph and collect the unique neighbour ids to fetch
  // plus their connecting edge + source candidate. Dedup (expandedMemoryIds) and
  // path tracking happen here exactly as before — only the per-id DB fetch is
  // deferred to the batch below.
  const _toExpand = []; // [{ relatedId, edge, candidateId }] in encounter order
  for (const candidate of initialCandidates) {
    const candidateId = candidate.memory?.id;
    if (!candidateId) continue;

    // Traverse graph to find related memories
    const relatedIds = traversal(candidateId, relationships, depth, relationshipTypes);

    for (const relatedId of relatedIds) {
      if (expandedMemoryIds.has(relatedId)) continue;

      // Find the edge connecting candidate to related memory
      const edgeKey = `${candidateId}-${relatedId}`;
      const reverseEdgeKey = `${relatedId}-${candidateId}`;
      const edge = relationshipLookup.get(edgeKey) || relationshipLookup.get(reverseEdgeKey);

      // Track path information for scoring
      if (!relationshipPaths.has(relatedId)) {
        relationshipPaths.set(relatedId, []);
      }
      relationshipPaths.get(relatedId).push({
        fromId: candidateId,
        edgeType: edge?.type || 'Unknown',
        confidence: edge?.confidence || 0.5
      });

      expandedMemoryIds.add(relatedId);
      _toExpand.push({ relatedId, edge, candidateId });
    }
  }

  // PASS 2: hydrate every neighbour in one store batch.  A Promise.all of
  // individual getMemory calls is only "concurrent", not a batch; for a
  // remote Memory Box it becomes one /hydrate request per graph neighbour and
  // can consume the tenant transport queue before the actual recall is done.
  // getMemories is a single findMany centrally and a single /v1/hydrate
  // remotely, while preserving the same absent-row behaviour.
  let _fetchedById = new Map();
  const _expandIds = [...new Set(_toExpand.map(({ relatedId }) => relatedId).filter(Boolean))];
  if (_expandIds.length) {
    try {
      if (typeof store.getMemories === 'function') {
        _fetchedById = await store.getMemories(_expandIds);
      } else {
        const rows = await Promise.all(_expandIds.map((relatedId) =>
          Promise.resolve(store.getMemory?.(relatedId)).catch(() => null)));
        _fetchedById = new Map(rows.filter(Boolean).map((memory) => [memory.id, memory]));
      }
    } catch {
      _fetchedById = new Map();
    }
  }

  // PASS 3 (sync): score + push in the SAME encounter order the serial loop
  // produced, so the output array (and the downstream MAX-dedup/merge) is
  // byte-identical to the pre-batch behaviour.
  for (const { relatedId, edge, candidateId } of _toExpand) {
    const relatedMemory = _fetchedById.get(relatedId);
    if (!relatedMemory) continue;

    // Calculate scores for expanded memory
    const similarityScore = computeTokenSimilarity(query_context || '', relatedMemory.content || '');
    const now = Date.now();
    const created = new Date(relatedMemory.created_at).getTime();
    const daysAgo = Number.isFinite(created) ? (now - created) / (1000 * 60 * 60 * 24) : 365;
    const recencyScore = Math.exp(-daysAgo / 30);
    const importanceScore = 1;
    const vectorScore = 0;

    // Graph score with base boost for being graph-discovered
    const baseGraphScore = Math.min((relationshipCounts.get(relatedId) || 0) * 0.03, 0.12);
    const expansionBoost = 0.08; // Base boost for graph-expanded memories
    const graphScore = baseGraphScore + expansionBoost;

    const policyScore = policyBoost(relatedMemory, {
      preferred_project,
      preferred_source_platforms,
      preferred_tags
    });

    // Calculate final score with penalty based on relationship type
    const edgeType = edge?.type || 'Unknown';
    const expansionPenalty = edgeType === 'Updates' ? 0.05
      : edgeType === 'Extends' ? 0.10
      : edgeType === 'Derives' ? 0.15
      : 0.15; // Default for unknown types
    const score = (
      (weights.similarity ?? 0.45) * similarityScore +
      (weights.recency ?? 0.15) * recencyScore +
      (weights.importance ?? 0.1) * importanceScore +
      (weights.vector ?? 0.2) * vectorScore +
      (weights.graph ?? 0.05) * graphScore +
      (weights.policy ?? 0.05) * policyScore
    ) * (1 - expansionPenalty);

    expandedCandidates.push({
      memory: relatedMemory,
      vectorScore,
      keywordScore: similarityScore,
      graphScore,
      policyScore,
      similarityScore,
      recencyScore,
      score,
      graph_expanded: true,
      expansion_metadata: {
        source_candidate_id: candidateId,
        relationship_type: edge?.type || 'Unknown',
        relationship_confidence: edge?.confidence || 0.5,
        traversal_depth: 1 // Track depth for future multi-depth scoring
      }
    });
  }

  return expandedCandidates;
}

/**
 * PHASE-B — Build the tiered "recall spine" view from already-scored/sliced
 * memories. Pure: no IO, no DB, no Qdrant. Never throws — on any error returns
 * empty tiers. Reuses the same synthesis predicates the main path uses.
 *
 * Tiers:
 *   l2_principles   — most distilled knowledge:
 *                       cognitive_layer_role ∈ {canonical, bridge}
 *                       OR source_metadata.source_type ∈ {canonical-fact, synthesis-bridge}
 *                       OR tags include synthesis:canonical / synthesis:bridge
 *   l1_summaries    — role ∈ {compression, reflection}
 *                       OR canonical-summary carrying a topic anchor
 *   supporting_facts— everything else
 *   bridges         — sub-list of l2 that are specifically synthesis-bridge
 *   evidence        — synthesized[].evidence flattened + deduped by id
 *
 * @param {Array}  flatMemories  Final sliced memories[] (each a flat memory object).
 * @param {Array}  synthesized   The synthesized[] rich array (carries .evidence[]).
 * @returns {{l2_principles:Array,l1_summaries:Array,supporting_facts:Array,evidence:Array,bridges:Array}}
 */
export function buildRecallSpine(flatMemories, synthesized) {
  const empty = { l2_principles: [], l1_summaries: [], supporting_facts: [], evidence: [], bridges: [] };
  try {
    const mems = Array.isArray(flatMemories) ? flatMemories : [];
    const synth = Array.isArray(synthesized) ? synthesized : [];

    const roleOf = (m) => m?.cognitive_layer_role || m?.cognitiveLayerRole || null;
    const srcTypeOf = (m) =>
      m?.source_metadata?.source_type || m?.sourceMetadata?.sourceType || m?.source_type || null;
    const tagsOf = (m) => (Array.isArray(m?.tags) ? m.tags : []);
    const hasTopicAnchor = (tags) =>
      tags.some((t) => typeof t === 'string' && (
        t === 'topic:knowledge-base' || t === 'topic:document' ||
        t.startsWith('topic:') || t.startsWith('entity:') || t.startsWith('person:')
      ));

    const isL2 = (m) => {
      const role = roleOf(m);
      if (role === 'canonical' || role === 'bridge') return true;
      const st = srcTypeOf(m);
      if (st === 'canonical-fact' || st === 'synthesis-bridge') return true;
      const tags = tagsOf(m);
      return tags.includes('synthesis:canonical') || tags.includes('synthesis:bridge');
    };
    const isBridge = (m) => {
      if (roleOf(m) === 'bridge') return true;
      if (srcTypeOf(m) === 'synthesis-bridge') return true;
      return tagsOf(m).includes('synthesis:bridge');
    };
    const isL1 = (m) => {
      const role = roleOf(m);
      if (role === 'compression' || role === 'reflection') return true;
      const tags = tagsOf(m);
      return tags.includes('canonical-summary') && hasTopicAnchor(tags);
    };

    const l2_principles = [];
    const l1_summaries = [];
    const supporting_facts = [];
    const bridges = [];

    for (const m of mems) {
      if (isL2(m)) {
        l2_principles.push(m);
        if (isBridge(m)) bridges.push(m);
      } else if (isL1(m)) {
        l1_summaries.push(m);
      } else {
        supporting_facts.push(m);
      }
    }

    const evidence = [];
    const seenEvidence = new Set();
    for (const s of synth) {
      const ev = Array.isArray(s?.evidence) ? s.evidence : [];
      for (const e of ev) {
        const id = e?.id;
        if (id == null) { evidence.push(e); continue; }
        if (seenEvidence.has(id)) continue;
        seenEvidence.add(id);
        evidence.push(e);
      }
    }

    return { l2_principles, l1_summaries, supporting_facts, evidence, bridges };
  } catch {
    return { ...empty };
  }
}

export async function recallPersistedMemories(store, opts) {
  // Residency: run the whole recall (incl. PG hydrate) in the org's context → customer PG for a
  // self-host org. Re-entrancy guard; undefined org → central (managed), unchanged.
  if (opts?.org_id && currentOrg() !== opts.org_id) return runWithOrg(opts.org_id, () => recallPersistedMemories(store, opts));
  return _recallPersistedMemoriesImpl(store, opts);
}
async function _recallPersistedMemoriesImpl(store, {
  query_context,
  query_vector = null,
  user_id,
  org_id,
  project,
  source_platforms = [],
  tags = [],
  preferred_project = null,
  preferred_source_platforms = [],
  preferred_tags = [],
  max_memories = 5,
  weights = { similarity: 0.45, recency: 0.15, importance: 0.1, vector: 0.2, graph: 0.05, policy: 0.05 },
  graph_expansion_depth = 2,
  date_range = null,
  valid_at = null,
  known_at = null,
  is_latest,           // boolean — undefined = default (true), false = include superseded
  include_expired,     // boolean — include expired memories
  sort,                // 'score' | 'date_asc' | 'date_desc'
  preference_boost,    // boolean — boost preference/personal/opinion memories
  include_superseded,  // boolean — include older update-chain versions via traverseUpdateChain
  raw_query = null,     // original user phrasing (pre-rewrite) for time-travel intent detection
  access_context = null, // { projectIds, teamIds } for V2 multi-tier scope filter
  structured_intent = false, // progressive router provides an LLM plan → skip English-keyword heuristics (e.g. detectMemoryTypeBoost); the planner-driven, language-neutral type boost is authoritative.
  scope_filter = null,   // optional MemoryScope filter: 'personal'|'project'|'team'|'organization'
                         // limits to memories whose scope === this value (in addition to access_context)
  entity_filter_mode = null, // per-call override of ENTITY_FILTER_MODE env (off|should|must)
                             // — lets the recall A/B eval toggle the entity lane without a restart
  tiered_view = null,        // per-call override of RECALL_TIERED_VIEW — turns on the algorithmic
                             // term-overlap ResultReranker at delivery (surfaces exact lexical
                             // matches over boosted-but-off-topic rows). null = env default.
  cross_rerank = null,       // when true, run the multilingual cross-encoder (Cohere v3.5) over the
                             // wide rerank window before delivery — recovers semantically-best rows
                             // (esp. cross-lingual) the bi-encoder ranks low. null = off.
  query_expansion = null,    // per-call override of RECALL_QUERY_EXPANSION — cross-lingual / sparse
  temporal_filter_mode = null,
                             // rescue: when the primary recall is THIN, translate/rephrase the query
                             // and merge extra candidates. null = env default.
  exact_source = false,
  canonical_entities = [],
  alternate_lexical_query = null,
  semantic_recovery = false,
  include_injection_context = true,
  // Rich synthesis cards are useful for recall API/graph consumers, but a
  // chat turn already receives its selected unified memory/evidence packets.
  // Make the expensive secondary evidence hydration explicitly opt-in so one
  // chat cannot fan out dozens of remote /hydrate calls for display-only data.
  include_synthesis_evidence = null,
  trace_stages = false,
  timing = null,
}) {
  const temporalExpansion = expandTemporalQuery(query_context);
  const effectiveDateRange = date_range || temporalExpansion.dateRange || null;
  const temporalComparison = temporalExpansion.hasTemporalFilter || isTemporalComparisonQuery(query_context);
  // Time-travel / bi-temporal lane: auto-open the Updates version-chain when the
  // query asks about change/history/as-of (or the caller explicitly requested
  // superseded). Gated → no-op + zero latency for ordinary queries.
  // Detect on the ORIGINAL user phrasing (raw_query) when provided — the
  // /api/recall handler rewrites/expands query_context for retrieval, which
  // strips the "how has X changed / as of …" signal the detector needs.
  const _timeTravelIntent = detectTimeTravelIntent(raw_query || query_context);
  const _wantVersionHistory = include_superseded === true || _timeTravelIntent;

  // ── Event-time ranking BOOST (gated EVENT_TIME_RANKING, default off) ──
  // SOFT additive score boost — NOT a filter — for candidates whose EVENT date
  // (ts:/time: tags, document_date, event_dates) falls in the query's temporal
  // window. Floats in-window memories to the top of the recalled set so they
  // survive RRF/MMR downstream and reach the answer model, fixing vague
  // temporal queries ("early June") that semantic recall alone ranked low.
  // Uses temporalExpansion.dateRange (tight start+end from the query text),
  // NOT effectiveDateRange (which may be a loose valid_at end-cap). Never drops.
  const _EVENT_TIME_RANKING = process.env.EVENT_TIME_RANKING !== 'false'; // default ON (A/B verified); disable with EVENT_TIME_RANKING=false
  const _eventWin = (_EVENT_TIME_RANKING && temporalExpansion?.dateRange?.start)
    ? { s: temporalExpansion.dateRange.start, e: temporalExpansion.dateRange.end || temporalExpansion.dateRange.start }
    : null;
  const _eventTimeBoost = (memory) => {
    if (!_eventWin) return 0;
    const dates = [];
    for (const t of (memory.tags || [])) { const m = /^(?:ts|time):(\d{4}-\d{2}-\d{2})/.exec(t); if (m) dates.push(m[1]); }
    if (memory.document_date) dates.push(String(memory.document_date).slice(0, 10));
    for (const d of (memory.event_dates || [])) dates.push(String(d).slice(0, 10));
    return dates.some((d) => d >= _eventWin.s && d <= _eventWin.e) ? 0.6 : 0;
  };
  // Env-gated stage timing (RECALL_LAP=true). Zero cost when off. Used to find
  // the latency hotspot inside the recall pipeline without per-stage tracing.
  const _LOG_LAP = process.env.RECALL_LAP === 'true';
  const _RLAP = _LOG_LAP || trace_stages;
  const _t0 = _RLAP ? Date.now() : 0;
  const _lap = {};
  const candidatePoolSize = boundedCandidatePool(max_memories, temporalComparison ? 8 : 4);
  // Phase 2 (B2): non-temporal score threshold comes from the per-org
  // RetrievalConfig (the self-evolution loop's primary Recall@K knob), falling
  // back to 0.20. Temporal queries keep the looser 0.15 floor for recall.
  // PHASE-F: optional per-org RetrievalConfig wiring (hnsw_ef + ranking weights).
  // Default OFF — when unset, behaviour is byte-identical: only score_threshold is
  // read (legacy semantics), weights stay at caller/default, hnswEf stays undefined.
  const _wireCfg = process.env.RETRIEVAL_CONFIG_WIRING === 'true';
  let _cfg = null;
  let _cfgThreshold = 0.20;
  // Single DB fetch reused for threshold + (when wired) hnsw_ef + weights. No extra call.
  try { _cfg = await getRetrievalConfig(org_id); _cfgThreshold = _cfg?.score_threshold ?? 0.20; } catch { /* default */ }
  const vectorScoreThreshold = temporalComparison ? 0.15 : _cfgThreshold;

  // PHASE-F: derive effective ranking weights. policy has NO RetrievalConfig column —
  // keep the caller/default value. All else from the same single _cfg fetch.
  const _effectiveWeights = (_wireCfg && _cfg)
    ? {
        similarity: _cfg.similarity_weight,
        recency:    _cfg.recency_weight,
        importance: _cfg.importance_weight,
        vector:     _cfg.vector_weight,
        graph:      _cfg.graph_weight,
        policy:     weights.policy ?? 0.05,
      }
    : weights;

  // is_latest: undefined = default true, false = include superseded versions
  const temporalSnapshot = !!(valid_at || known_at);
  const snapshotValidAt = valid_at || null;
  // For valid-time travel, retrieve the current semantic head first, traverse
  // its Updates chain, and only then apply the valid interval. Pre-filtering the
  // retrieval lanes by valid_at removes the current head and makes historical
  // versions unreachable. known_at remains a retrieval-time constraint because
  // transaction-time snapshots must never see rows ingested later.
  const retrievalValidAt = (_wantVersionHistory && snapshotValidAt) ? null : snapshotValidAt;
  const effectiveIsLatest = temporalSnapshot ? undefined : (is_latest !== undefined ? is_latest : true);

  // Load WorkingSet for this user (rolling spotlight on active context).
  // Used downstream to boost memories whose entity/thread/project tags
  // overlap what the user is currently working on. Read-only; non-fatal on
  // failure — empty set just means no boost fires.
  let _workingSet = { activeEntities: [], activeThreads: [], activeProjects: [], pinnedMemoryIds: [] };
  if (store?.client?.workingSet && user_id) {
    try {
      const ws = await store.client.workingSet.findUnique({ where: { userId: user_id } });
      if (ws) _workingSet = ws;
    } catch (wsErr) {
      // Non-fatal — proceed without boost
    }
  }
  const _wsEntitiesLower = new Set((_workingSet.activeEntities || []).map((e) => String(e).toLowerCase()));
  const _wsThreads = new Set(_workingSet.activeThreads || []);
  const _wsProjects = new Set(_workingSet.activeProjects || []);
  const _wsPinned = new Set((_workingSet.pinnedMemoryIds || []).map((id) => String(id)));

  // ── Entity/tag-filter-first (gated: ENTITY_FILTER_MODE = off | should | must) ──
  // off   → byte-identical to legacy (no entity tags computed).
  // should→ additive precision pass below (floor preserved; never drops).
  // must  → hard-require an entity-tag match on the primary passes (DROPS
  //         untagged memories — only safe after the G1 symmetry test proves
  //         ≥80% extraction recall; default off).
  // GLOBAL entity recall (all tenants, no per-tenant config): always run BOTH
  // paths — the unfiltered wide search AND an entity-tag-filtered wide search —
  // then fuse + rerank down to the delivered set ("search wide, rank narrow").
  // Default 'should' (additive, never narrows the main set). Tenant-registry
  // canonical entities and deterministic query tokens feed this lane. The
  // legacy LLM extractor is disabled unless explicitly enabled for an eval.
  const ENTITY_FILTER_MODE = (entity_filter_mode || process.env.ENTITY_FILTER_MODE || 'should').toLowerCase();
  const _entityTagsPromise = ENTITY_FILTER_MODE !== 'off'
    ? (async () => {
        const _canonical = (Array.isArray(canonical_entities) ? canonical_entities : [])
          .flatMap((entity) => {
            const normalized = normalizeEntity(entity);
            return normalized ? [`entity:${normalized}`, `entity:${normalized.toLowerCase()}`] : [];
          });
        const _regex = normalizeQueryEntityTokens(query_context);
        const _llm = await extractQueryEntitiesLLM(query_context, org_id);
        return [...new Set([..._canonical, ..._regex, ..._llm])];
      })()
    : Promise.resolve([]);
  // 'must' (hard filter) needs the tags before the main fetch; 'should' (global
  // default) does not — main fetch runs unfiltered while extraction overlaps it.
  let _entityFilterTags = [];
  if (ENTITY_FILTER_MODE === 'must') _entityFilterTags = await _entityTagsPromise;
  const _effectiveTags = (ENTITY_FILTER_MODE === 'must' && _entityFilterTags.length)
    ? [...tags, ..._entityFilterTags]
    : tags;

  // ── Temporal tag-filter-first (gated: TEMPORAL_FILTER_MODE = off | should) ──
  // Mirrors the entity SHOULD pass: when the query carries a date anchor
  // ("yesterday", "last week", "on Monday", an explicit 2026-06-09), emit the
  // matching `ts:`/`time:` OR-candidates and run ONE additive vector pass that
  // can only ADD date-matched memories (never drops — the unfiltered passes
  // remain the recall floor). `must` is intentionally NOT supported: the FTS
  // path AND-matches tags (hasEvery), and a multi-day OR set would zero out;
  // the Qdrant additive pass (any-match) is the correct, safe mechanism.
  // Default ON ('should') in production: the additive temporal pass is a no-op
  // for non-date queries (normalizeQueryTemporalTokens returns [] → pass skipped)
  // and only ADDS date-matched memories for date-anchored queries — verified
  // byte-identical on non-temporal recall. Set TEMPORAL_FILTER_MODE=off to disable.
  const TEMPORAL_FILTER_MODE = (temporal_filter_mode || process.env.TEMPORAL_FILTER_MODE || 'should').toLowerCase();
  const _temporalFilterTags = TEMPORAL_FILTER_MODE === 'should'
    ? normalizeQueryTemporalTokens(query_context, Date.now())
    : [];

  // Independent retrieval lanes run CONCURRENTLY: the base vector fetch (embed +
  // Qdrant, ~400ms) is kicked off here so it overlaps the lexical FTS lane
  // (~500ms) + the synchronous lexical filter below, instead of running after
  // it. Output is byte-identical — same inputs, same filter, just no longer
  // serialized — so accuracy is unchanged (Solvis combo@8 eval-gated). The
  // result is consumed at `await _vectorCandidatesPromise` further down.
  const _vectorCandidatesPromise = vectorCandidatesForRecall(store, {
    query_context,
    query_vector,
    user_id,
    org_id,
    project,
    source_platforms,
    tags: _effectiveTags,
    max_memories,
    dateRange: effectiveDateRange,
    validAt: retrievalValidAt,
    knownAt: known_at,
    scoreThreshold: vectorScoreThreshold,
    hnswEf: _wireCfg ? _cfg?.hnsw_ef : undefined, // PHASE-F: per-org ef_search when wired; undefined otherwise (dark-safe)
    candidatePoolSize,
    is_latest: effectiveIsLatest,
    access_context,
    scope_filter,
    timing,
  })
    // Drop old TARA turn/insight vectors still living in Qdrant from past calls.
    .then((cands) => cands.filter((c) => !isTaraActivity(c?.memory) && !isRecallNoise(c?.memory)));
  // Mark handled so that if the lexical lane below throws first, the in-flight
  // vector promise doesn't surface as an unhandledRejection. The real `await`
  // further down still propagates any vector error (semantics preserved).
  _vectorCandidatesPromise.catch(() => {});

  // More independent I/O lanes kicked off CONCURRENTLY here (overlapping the
  // lexical FTS lane + the synchronous lexical filter below + each other),
  // instead of running one-after-another after the base vector resolves:
  //   • relationships graph fetch (needed by scoring + graph expansion)
  //   • the SHOULD-mode temporal additive vector pass (its tags are sync-ready)
  //   • the SHOULD-mode entity additive vector pass (chained off the entity-tag
  //     LLM extraction that was already running in parallel)
  // All are ADDITIVE / order-independent (folded into the same MAX-dedup merge)
  // and read-only, so output is unchanged — only the wall-clock collapses from
  // sum-of-lanes to max-of-lanes. Consumed at the Promise.all further down.
  const _relationshipsPromise = graph_expansion_depth > 0
    ? store.listRelationships({ user_id, org_id, project, limit: 1000 })
    : Promise.resolve([]);
  _relationshipsPromise.catch(() => {});

  const _temporalCandidatesPromise = (TEMPORAL_FILTER_MODE === 'should' && _temporalFilterTags.length)
    ? vectorCandidatesForRecall(store, {
        query_context, user_id, org_id, project, source_platforms,
        tags: _temporalFilterTags, max_memories,
        dateRange: null, validAt: retrievalValidAt, knownAt: known_at,
        scoreThreshold: vectorScoreThreshold,
        hnswEf: _wireCfg ? _cfg?.hnsw_ef : undefined,
        candidatePoolSize, is_latest: effectiveIsLatest, access_context, scope_filter,
      })
        .then((cands) => cands.filter((c) => !isTaraActivity(c?.memory) && !isRecallNoise(c?.memory)).map((c) => ({ ...c, _temporal_filtered: true })))
        .catch(() => [])
    : Promise.resolve([]);
  _temporalCandidatesPromise.catch(() => {});

  // Entity additive pass overlaps too — it waits only on the entity-tag LLM
  // extraction (already in flight), not on the main fetch. SHOULD mode only;
  // 'must' mode resolved its tags into _effectiveTags above (hard filter).
  const _entityCandidatesPromise = (ENTITY_FILTER_MODE === 'should')
    ? _entityTagsPromise.then((entityTags) => {
        if (!entityTags || !entityTags.length) return [];
        return vectorCandidatesForRecall(store, {
          query_context, user_id, org_id, project, source_platforms,
          tags: entityTags, max_memories,
          dateRange: effectiveDateRange, validAt: retrievalValidAt, knownAt: known_at,
          scoreThreshold: vectorScoreThreshold,
          hnswEf: _wireCfg ? _cfg?.hnsw_ef : undefined,
          candidatePoolSize, is_latest: effectiveIsLatest, access_context, scope_filter,
        })
          .then((cands) => cands.filter((c) => !isTaraActivity(c?.memory) && !isRecallNoise(c?.memory)).map((c) => ({ ...c, _entity_filtered: true })));
      }).catch(() => [])
    : Promise.resolve([]);
  _entityCandidatesPromise.catch(() => {});

  // ── Hop-0 canonical-entity lane (gated: RECALL_ENTITY_HOP0, default on) ──
  // Bounded DETERMINISTIC registry lookup (indexed entity tables, no LLM)
  // that surfaces entity-linked memories as ADDITIVE candidates. Overlaps the
  // other lanes; ~125ms deadline; fails open to [] so it can never delay or
  // narrow ordinary recall. See entity-hop0.js for caps + matching rules.
  const _ENTITY_HOP0_EMPTY = { candidates: [], matchedEntities: [], matchedQueryEntityCount: 0, latencyMs: 0, cutoff: false };
  const _entityHop0Promise = (process.env.RECALL_ENTITY_HOP0 !== 'false')
    ? resolveEntityRecallCandidates({
      store,
      query: query_context,
      canonicalEntities: canonical_entities,
      org_id,
        user_id,
        access_context,
        scope_filter,
        dateRange: effectiveDateRange,
        validAt: retrievalValidAt,
        knownAt: known_at,
        is_latest: effectiveIsLatest,
        excludeMemory: (m) => isTaraActivity(m) || isRecallNoise(m),
        isMemoryInDateRange,
        isMemoryInTemporalSnapshot,
      }).catch(() => _ENTITY_HOP0_EMPTY)
    : Promise.resolve(_ENTITY_HOP0_EMPTY);
  _entityHop0Promise.catch(() => {});

  // Observation-prefix (Mastra-style stable context) depends ONLY on
  // (user, org, project) — NOT on the recall results — yet was assembled at the
  // very END, serialized after all scoring/dedup. It does a listLatestMemories
  // DB scan, so on a large org it's a few hundred ms of dead serial time. Kick
  // it off here so it overlaps the entire recall pipeline; consumed right before
  // delivery. Identical output (same prefix), wall-clock only.
  const _observationPrefixPromise = include_injection_context ? (async () => {
    try {
      if (!store) return { prefix: '', observationCount: 0 };
      const { CognitiveOperator } = await import('./operator-layer.js');
      return await new CognitiveOperator({ store }).assembleObservationPrefix(user_id, org_id, { project, maxTokens: 4000 });
    } catch { return { prefix: '', observationCount: 0 }; }
  })() : Promise.resolve({ prefix: '', observationCount: 0 });
  _observationPrefixPromise.catch(() => {});

  // User-profile injection (static facts) also depends only on (user, org) and
  // was awaited serially in the tail — hoist it to overlap the pipeline too.
  const _userProfilePromise = include_injection_context ? (async () => {
    try {
      if (!store) return { profile: '' };
      const { UserProfile } = await import('./user-profile.js');
      return await new UserProfile(store).getProfile(user_id, org_id);
    } catch { return { profile: '' }; }
  })() : Promise.resolve({ profile: '' });
  _userProfilePromise.catch(() => {});

  const lexicalArgs = {
    user_id, org_id, project, tags: _effectiveTags, is_latest: effectiveIsLatest,
    n_results: candidatePoolSize, created_after: effectiveDateRange?.start,
    created_before: effectiveDateRange?.end, valid_at: retrievalValidAt, known_at, access_context,
    // This function already starts the semantic vector lane above. Remote
    // stores historically repeated vector retrieval inside searchMemories(),
    // turning the nominal lexical lane into a second hybrid search.
    lexical_only: true,
  };
  const lexicalQueries = [...new Set([query_context, alternate_lexical_query]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim()))].slice(0, 2);
  const lexicalStartedAt = timing ? Date.now() : 0;
  const lexicalLanes = await Promise.all(lexicalQueries.map((query) =>
    store.searchMemories({ ...lexicalArgs, query })));
  if (timing) timing.lexical_ms = Date.now() - lexicalStartedAt;
  const lexicalCandidates = [...new Map(
    lexicalLanes.flat().filter((memory) => memory?.id).map((memory) => [memory.id, memory]),
  ).values()];

  const filteredLexical = lexicalCandidates.filter(memory => {
    const memTags = memory.tags || [];
    // Exclude TARA voice activity (turns/insights/call-logs/session state) from
    // recall — isolated noise, surfaced only via the /tara Call History tab.
    if (isTaraActivity(memory)) return false;
    // Governance audit-reflection + room-decision noise — never recall.
    if (isRecallNoise(memory)) return false;
    // Exclude benchmark data from production recall when no specific project is set
    if (!project && memTags.includes('longmemeval')) return false;
    if (!isMemoryInDateRange(memory, effectiveDateRange)) return false;
    if (!isMemoryInTemporalSnapshot(memory, { validAt: snapshotValidAt, knownAt: known_at })) return false;
    if (!matchesMemoryAccess(memory, { userId: user_id, orgId: org_id, accessContext: access_context })) return false;
    if (!matchesScopeFilter(memory, scope_filter)) return false;
    // Exclude canonical-summary rows from default recall — BUT ONLY the
    // generic chat / conversation compactions. Knowledge-base, document,
    // entity-scoped, and entity-tagged compactions are the substantive
    // content (drift compaction soft-deletes the originals and stores the
    // merged view in the canonical), so filtering them blinds the agent
    // to ingested PDFs, topic-scoped synthesis, and entity-rich chat
    // compactions where the entity tag carries the topical signal.
    // Callers wanting the noisy chat-style canonicals back can pass
    // tags=['canonical-summary'] explicitly.
    if (
      !tags.includes('canonical-summary') &&
      memTags.includes('canonical-summary') &&
      !memTags.some(t =>
        t === 'topic:knowledge-base' ||
        t === 'topic:document' ||
        (typeof t === 'string' && (
          t.startsWith('topic:entity:') ||
          t.startsWith('entity:') ||
          t.startsWith('person:')
        ))
      )
    ) return false;
    if (source_platforms.length === 0) return true;
    const sourcePlatform = memory.source_metadata?.source_platform || memory.source || null;
    return source_platforms.includes(sourcePlatform);
  });

  // Consume the base vector lane started concurrently with the lexical fetch
  // above (overlapped, not serialized). Any vector-fetch error propagates here
  // exactly as it did when this was a direct `await`.
  const vectorCandidates = await _vectorCandidatesPromise;

  // Cross-lingual / sparse rescue: a THIN primary recall is the signature of a
  // cross-lingual query (English question over German docs → every row low-
  // cosine, few clear the floor). Translate/rephrase the query and merge extra
  // candidates with a relaxed floor. Gated + thin-only → the rich-corpus happy
  // path stays LLM-free and fast.
  let crosslingualCandidates = [];
  const _doExpand = query_expansion != null ? !!query_expansion : QUERY_EXPANSION_ENABLED;
  if (_doExpand && vectorCandidates.length < EXPAND_MIN_CANDIDATES) {
    const _variants = await expandQueryMultilingual(query_context, org_id);
    if (_variants.length) {
      const _fetched = await Promise.all(_variants.map((v) => vectorCandidatesForRecall(store, {
        query_context: v, user_id, org_id, project, source_platforms,
        tags: _effectiveTags, max_memories, dateRange: effectiveDateRange,
        validAt: snapshotValidAt, knownAt: known_at,
        scoreThreshold: Math.min(vectorScoreThreshold ?? 0.25, 0.12), // relax for cross-lingual low-cosine
        hnswEf: _wireCfg ? _cfg?.hnsw_ef : undefined,
        candidatePoolSize, is_latest: effectiveIsLatest, access_context, scope_filter,
      }).then((cands) => cands.filter((c) => !isTaraActivity(c?.memory) && !isRecallNoise(c?.memory))).catch(() => [])));
      const _seen = new Set(vectorCandidates.map((c) => c?.memory?.id).filter(Boolean));
      for (const arr of _fetched) {
        for (const c of arr) {
          const id = c?.memory?.id;
          if (id && !_seen.has(id)) { _seen.add(id); crosslingualCandidates.push(c); }
        }
      }
    }
  }

  // ADDITIVE entity + temporal passes (SHOULD mode) and the relationships graph
  // were all kicked off CONCURRENTLY at the top of this function (overlapping the
  // base vector + lexical lanes). Resolve them together in one barrier here.
  // Both additive passes are folded into the same MAX-dedup merge downstream and
  // never remove (the unfiltered passes remain the recall floor), so output is
  // identical to the previous serial form — only wall-clock collapses.
  //   • entity pass: _entity_filtered tag set inside the promise
  //   • temporal pass: COMPLEMENTARY to effectiveDateRange — it any-matches the
  //     ingest ts:/time: EVENT-time tags (dateRange:null), surfacing memories a
  //     record-time window misses. _temporal_filtered tag set inside the promise.
  const [entityFilteredCandidates, temporalFilteredCandidates, relationships, _entityHop0] = await Promise.all([
    _entityCandidatesPromise,
    _temporalCandidatesPromise,
    _relationshipsPromise,
    _entityHop0Promise,
  ]);
  const entityHop0Candidates = Array.isArray(_entityHop0?.candidates) ? _entityHop0.candidates : [];
  // Keep _entityFilterTags populated for any downstream reference. The extraction
  // promise is already settled (the entity pass above awaited it); this is a
  // no-op await that just surfaces the resolved tags. 'must' mode set it earlier.
  if (ENTITY_FILTER_MODE === 'should') {
    try { _entityFilterTags = await _entityTagsPromise; } catch { _entityFilterTags = []; }
  }
  const relationshipCounts = buildRelationshipIndex(relationships);
  const contradictedIds    = buildContradictedIndex(relationships);       // Map<to_id,{createdBy,_ts}>
  const correctionWinners  = buildCorrectionWinnerIndex(relationships);   // Map<from_id,_ts>
  const _nowMs             = Date.now();
  if (_RLAP) _lap.fetch = Date.now() - _t0;

  // Graph Expansion: Discover related memories through graph traversal
  const initialCandidates = boundedLaneFusion([
    filteredLexical.map((memory) => ({ memory, score: 0 })),
    vectorCandidates,
    crosslingualCandidates,
    entityFilteredCandidates,
    temporalFilteredCandidates,
    entityHop0Candidates,
  ]);
  const expandedCandidates = await expandCandidatesViaGraph(store, {
    initialCandidates,
    relationships,
    relationshipCounts,
    query_context,
    weights: _effectiveWeights, // PHASE-F: per-org ranking weights when wired, else caller/default
    preferred_project,
    preferred_source_platforms,
    preferred_tags,
    depth: graph_expansion_depth
  });
  if (_RLAP) _lap.expand = Date.now() - _t0;

  const scoredLexical = filteredLexical.map(memory => {
    if (!isMemoryInDateRange(memory, effectiveDateRange)) {
      return null;
    }

    // Memory matched via FTS over content+title+tags → treat as a
    // strong signal. ts_rank returns small absolute values (0.001-0.5),
    // unsafe to use as-is in the weighted formula. Floor at 0.7 when
    // present so a tag-only hit (e.g. filename:Branding Skizze1) still
    // ranks competitively with content-overlap matches.
    const hasFtsHit = typeof memory.score === 'number' && memory.score > 0;
    const tokenSim = computeTokenSimilarity(
      query_context || '',
      `${memory.content || ''} ${memory.title || ''} ${(memory.tags || []).join(' ')}`,
    );
    const similarityScore = hasFtsHit ? Math.max(0.7, tokenSim) : tokenSim;
    const now = Date.now();
    const created = new Date(memory.created_at).getTime();
    const daysAgo = Number.isFinite(created) ? (now - created) / (1000 * 60 * 60 * 24) : 365;
    const recencyScore = Math.exp(-daysAgo / 30);
    // Base importance = 1 for scoring formula; actual importance_score applied later in boost phase
    const importanceScore = 1;
    const vectorScore = 0;
    const graphScore = Math.min((relationshipCounts.get(memory.id) || 0) * 0.03, 0.12);
    const policyScore = policyBoost(memory, {
      preferred_project,
      preferred_source_platforms,
      preferred_tags
    });
    const temporalBoost = temporalSignalBoost(memory, query_context, temporalComparison);
    // PHASE-F: _effectiveWeights === weights when wiring OFF (byte-identical scoring).
    let score = (_effectiveWeights.similarity ?? 0.45) * similarityScore +
        (_effectiveWeights.recency ?? 0.15) * recencyScore +
        (_effectiveWeights.importance ?? 0.1) * importanceScore +
        (_effectiveWeights.vector ?? 0.2) * vectorScore +
        (_effectiveWeights.graph ?? 0.05) * graphScore +
        (_effectiveWeights.policy ?? 0.05) * policyScore +
        temporalBoost + _eventTimeBoost(memory);
    // Superseded memory penalty
    if (!temporalSnapshot && memory.is_latest === false) score *= 0.55;
    // Stale-superseded penalty: superseded AND >30 days old gets extra
    // downweight. Catches old revisions that linger after drift compaction.
    if (!temporalSnapshot && memory.is_latest === false && daysAgo > 30) score *= 0.70;
    // Contradiction penalty (WS2 temporal): a freshly-stated contradiction hard-
    // demotes its target (poisoned-preference fix — the just-corrected fact sinks);
    // an old one softens. The later-stated "winner" gets a recency boost so it
    // floats to the top on the very next recall, no cron wait.
    score *= contradictionPenalty(contradictedIds.get(memory.id), _nowMs);
    score *= correctionWinnerBoost(correctionWinners.get(memory.id), _nowMs);
    // Content attribution: deprioritize third-party/noise content
    const attribution = memory.metadata?.content_attribution;
    if (attribution === 'newsletter') score *= 0.5;
    else if (attribution === 'third_party') score *= 0.8;
    // Tag-based noise demotion: catches connector ingests that didn't get
    // an explicit content_attribution. Each tag stacks multiplicatively but
    // floors at 0.15 so noise can still surface when nothing better matches.
    const _tagsForNoise = Array.isArray(memory.tags) ? memory.tags : [];
    let _noiseMul = 1;
    if (_tagsForNoise.some((t) => t === 'updates' || t === 'label:updates' || t === 'newsletter')) _noiseMul *= 0.40;
    if (_tagsForNoise.some((t) => t === 'promotions' || t === 'label:promotions')) _noiseMul *= 0.30;
    if (_tagsForNoise.some((t) => t === 'social' || t === 'label:social' || t === 'forums' || t === 'label:forums')) _noiseMul *= 0.50;
    if (_tagsForNoise.some((t) => t === 'notification' || t === 'automated' || t === 'no-reply')) _noiseMul *= 0.35;
    if (_noiseMul < 1) score *= Math.max(_noiseMul, 0.15);
    // First-person BOOST: mails the user actually wrote (sent-by-user) are
    // ground truth — their own thoughts, decisions, replies. Lift the score
    // so they always outrank received noise on tie-equivalent vectors.
    if (_tagsForNoise.some((t) => t === 'sent-by-user' || t === 'first-person')) score *= 1.25;
    // Retroactive detection for untagged existing memories
    if (!attribution) {
      const c = safeRecallText(memory.content).toLowerCase();
      const t = safeRecallText(memory.title).toLowerCase();
      if (c.includes('unsubscribe') || c.includes('noreply') || c.includes('no-reply') || c.includes('click here to unsub')) score *= 0.3;
      else if (t.startsWith('clinical insight') || t.startsWith('tara turn')) score *= 0.4;
      else if (t.startsWith('session:')) score *= 0.5;
    }
    return {
      memory,
      vectorScore,
      keywordScore: similarityScore,
      graphScore,
      policyScore,
      temporalBoost,
      similarityScore,
      recencyScore,
      score
    };
  }).filter(Boolean);

  const enrichedVector = vectorCandidates.map(candidate => {
    if (!isMemoryInDateRange(candidate.memory, effectiveDateRange)) {
      return null;
    }

    const now = Date.now();
    const created = new Date(candidate.memory.created_at).getTime();
    const daysAgo = Number.isFinite(created) ? (now - created) / (1000 * 60 * 60 * 24) : 365;
    const recencyScore = Math.exp(-daysAgo / 30);
    // Base importance = 1 for scoring formula; actual importance_score applied later in boost phase
    const importanceScore = 1;
    const graphScore = Math.min((relationshipCounts.get(candidate.memory.id) || 0) * 0.03, 0.12);
    const policyScore = policyBoost(candidate.memory, {
      preferred_project,
      preferred_source_platforms,
      preferred_tags
    });
    const temporalBoost = temporalSignalBoost(candidate.memory, query_context, temporalComparison);

    // PHASE-F: _effectiveWeights === weights when wiring OFF (byte-identical scoring).
    let score = (_effectiveWeights.similarity ?? 0.45) * (candidate.similarityScore || 0) +
        (_effectiveWeights.recency ?? 0.15) * recencyScore +
        (_effectiveWeights.importance ?? 0.1) * importanceScore +
        (_effectiveWeights.vector ?? 0.2) * (candidate.vectorScore || 0) +
        (_effectiveWeights.graph ?? 0.05) * graphScore +
        (_effectiveWeights.policy ?? 0.05) * policyScore +
        temporalBoost + _eventTimeBoost(candidate.memory);
    // Superseded memory penalty
    if (!temporalSnapshot && candidate.memory?.is_latest === false) score *= 0.55;
    // Stale-superseded penalty (>30d) + contradiction penalty (WS2 temporal).
    if (!temporalSnapshot && candidate.memory?.is_latest === false && daysAgo > 30) score *= 0.70;
    if (candidate.memory?.id) {
      score *= contradictionPenalty(contradictedIds.get(candidate.memory.id), _nowMs);
      score *= correctionWinnerBoost(correctionWinners.get(candidate.memory.id), _nowMs);
    }
    // Content attribution: deprioritize third-party/noise content
    const attribution = candidate.memory?.metadata?.content_attribution;
    if (attribution === 'newsletter') score *= 0.5;
    else if (attribution === 'third_party') score *= 0.8;
    // Retroactive detection for untagged existing memories
    if (!attribution && candidate.memory) {
      const c = safeRecallText(candidate.memory.content).toLowerCase();
      const t = safeRecallText(candidate.memory.title).toLowerCase();
      if (c.includes('unsubscribe') || c.includes('noreply') || c.includes('no-reply') || c.includes('click here to unsub')) score *= 0.3;
      else if (t.startsWith('clinical insight') || t.startsWith('tara turn')) score *= 0.4;
      else if (t.startsWith('session:')) score *= 0.5;
    }
    return {
      ...candidate,
      keywordScore: candidate.similarityScore || 0,
      graphScore,
      policyScore,
      temporalBoost,
      recencyScore,
      score
    };
  }).filter(Boolean);

  // Score the event-time temporal candidates and merge them DIRECTLY (not just
  // as BFS seeds — expandCandidatesViaGraph only returns neighbours). These
  // INTENTIONALLY skip the isMemoryInDateRange(effectiveDateRange) drop the
  // vector/lexical paths apply: a memory tagged `time:2026-07-01` but created
  // earlier is exactly what record-time filtering misses. Scored with the same
  // weighted formula so they rank fairly against the other lists.
  const scoredTemporal = temporalFilteredCandidates.map(candidate => {
    const now = Date.now();
    const created = new Date(candidate.memory?.created_at).getTime();
    const daysAgo = Number.isFinite(created) ? (now - created) / (1000 * 60 * 60 * 24) : 365;
    const recencyScore = Math.exp(-daysAgo / 30);
    const graphScore = Math.min((relationshipCounts.get(candidate.memory?.id) || 0) * 0.03, 0.12);
    const policyScore = policyBoost(candidate.memory, { preferred_project, preferred_source_platforms, preferred_tags });
    let score = (_effectiveWeights.similarity ?? 0.45) * (candidate.similarityScore || 0) +
        (_effectiveWeights.recency ?? 0.15) * recencyScore +
        (_effectiveWeights.importance ?? 0.1) * 1 +
        (_effectiveWeights.vector ?? 0.2) * (candidate.vectorScore || 0) +
        (_effectiveWeights.graph ?? 0.05) * graphScore +
        (_effectiveWeights.policy ?? 0.05) * policyScore + _eventTimeBoost(candidate.memory);
    if (!temporalSnapshot && candidate.memory?.is_latest === false) score *= 0.55;
    if (candidate.memory?.id) {
      score *= contradictionPenalty(contradictedIds.get(candidate.memory.id), _nowMs);
      score *= correctionWinnerBoost(correctionWinners.get(candidate.memory.id), _nowMs);
    }
    return { ...candidate, keywordScore: candidate.similarityScore || 0, graphScore, policyScore, recencyScore, score };
  }).filter(c => c.memory?.id);

  // Score the Hop-0 entity-lane candidates and merge them DIRECTLY (same
  // pattern as scoredTemporal). They carry no vector similarity — their claim
  // to relevance is the deterministic entity match, applied as a BOUNDED boost
  // (≤0.45) plus a small multi-entity coverage bonus (≤0.15). Semantic and
  // lexical relevance still decide the final order: an entity match lifts a
  // candidate into contention, it cannot override an on-topic result. All
  // penalties (superseded/contradiction/attribution) apply identically.
  const _hop0CoverageBoost = Math.min(0.15, (_entityHop0?.matchedQueryEntityCount || 0) * 0.05);
  const scoredEntityHop0 = entityHop0Candidates.map(candidate => {
    const now = Date.now();
    const created = new Date(candidate.memory?.created_at).getTime();
    const daysAgo = Number.isFinite(created) ? (now - created) / (1000 * 60 * 60 * 24) : 365;
    const recencyScore = Math.exp(-daysAgo / 30);
    const graphScore = Math.min((relationshipCounts.get(candidate.memory?.id) || 0) * 0.03, 0.12);
    const policyScore = policyBoost(candidate.memory, { preferred_project, preferred_source_platforms, preferred_tags });
    const entityBoost = Math.min(0.45, (candidate._entity_match_score || 0) * 0.45);
    let score = (_effectiveWeights.recency ?? 0.15) * recencyScore +
        (_effectiveWeights.importance ?? 0.1) * 1 +
        (_effectiveWeights.graph ?? 0.05) * graphScore +
        (_effectiveWeights.policy ?? 0.05) * policyScore +
        entityBoost + _hop0CoverageBoost + _eventTimeBoost(candidate.memory);
    if (!temporalSnapshot && candidate.memory?.is_latest === false) score *= 0.55;
    if (candidate.memory?.id) {
      score *= contradictionPenalty(contradictedIds.get(candidate.memory.id), _nowMs);
      score *= correctionWinnerBoost(correctionWinners.get(candidate.memory.id), _nowMs);
    }
    // The deterministic entity match IS this candidate's lexical-relevance
    // evidence. Carry it (scaled) as keyword/similarity signal so
    // applyRecallRelevanceFloor's HARD_MIN_SIMILARITY (0.10) doesn't silently
    // drop Hop-0-only candidates: exact match (0.5) clears every floor; a weak
    // partial (0.15) clears only the hard floor and yields to strong semantic
    // hits — entity matching boosts relevance, it does not override it.
    const _lexEvidence = Math.max(0, Math.min(0.5, (candidate._entity_match_score || 0) * 0.5));
    return { ...candidate, keywordScore: _lexEvidence, similarityScore: _lexEvidence, graphScore, policyScore, recencyScore, score };
  }).filter(c => c.memory?.id);

  const ranked = mergeCandidateLists(scoredLexical, enrichedVector, expandedCandidates, scoredTemporal, scoredEntityHop0)
    // Deterministic ordering: score desc, then a STABLE id tie-break so equal
    // scores never reorder run-to-run (the "sometimes works, sometimes not"
    // non-determinism). Same input → same candidate order → same rerank window.
    .sort((a, b) => (b.score - a.score) || String(a.memory?.id || a.id || '').localeCompare(String(b.memory?.id || b.id || '')));

  // Rarity-weighted distinctive-token boost (hybrid lexical recall, flag-gated).
  // ts_rank + vector similarity both reward the COMMON brand token (e.g. every
  // "solvis" memory), drowning the RARE decisive token ("pia", "tim") that
  // actually answers an entity-specific query — so "launch date of solvis pia"
  // buried the PIA event under generic brand facts. This boosts candidates that
  // carry the query's rare tokens, using in-set inverse doc-frequency (no extra
  // DB query) + substring match (catches concatenated names like SolvisTim).
  // Default OFF → no change.
  if (process.env.HYBRID_LEXICAL_RECALL === 'true' && ranked.length > 1) {
    const qToks = [...new Set(String(query_context || '').toLowerCase().split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]/g, '')).filter((w) => w.length >= 3))];
    if (qToks.length) {
      const N = ranked.length;
      const texts = ranked.map((c) => `${safeRecallText(c.memory?.title)} ${safeRecallText(c.memory?.content)}`.toLowerCase());
      const df = {};
      for (const t of qToks) df[t] = texts.filter((x) => x.includes(t)).length;
      const weight = (t) => (df[t] > 0 ? Math.max(0, 1 - df[t] / N) : 0); // in every candidate → 0; rare → ~1
      const ALPHA = Number(process.env.HYBRID_RARE_ALPHA || 0.6);
      for (let i = 0; i < ranked.length; i += 1) {
        let boost = 0;
        for (const t of qToks) if (texts[i].includes(t)) boost += weight(t);
        if (boost > 0) ranked[i].score = (Number(ranked[i].score) || 0) * (1 + ALPHA * boost);
      }
      ranked.sort((a, b) => b.score - a.score);
    }
  }

  // Apply memory_type boosting based on query intent (from code-review-graph's kind boosting).
  // GATED: only in the legacy non-structured path. Under the progressive router
  // (structured_intent=true) this English-keyword detector is skipped — it double-boosted
  // against the planner-driven, language-neutral boost_memory_type (≈×2.56, English-only)
  // and produced different rankings per language. The planner signal is authoritative there.
  const typeBoosts = structured_intent ? {} : detectMemoryTypeBoost(query_context);
  if (Object.keys(typeBoosts).length > 0) {
    for (const item of ranked) {
      const memType = item.memory?.memory_type || '';
      if (typeBoosts[memType]) {
        item.score = (item.score || 0) * typeBoosts[memType];
      }
    }
    ranked.sort((a, b) => b.score - a.score);
  }

  let filtered = applyRecallRelevanceFloor(ranked, { temporalComparison, semanticRecovery: semantic_recovery });

  // SCOPE ENFORCEMENT (universal, post-merge): the chat scope selector (personal/project/team)
  // must actually restrict the delivered set. The per-lane checks (786/1618) run before some
  // candidates carry .scope and are bypassed by the merge/rerank path, so enforce it once here
  // on the fully-merged, scope-hydrated pool. Mirrors the per-lane rule (drop only a present,
  // mismatched scope; keep scope-less rows). 'organization'/none is passed as null → no filter
  // (everything the access_context already allows in the org).
  if (scope_filter) {
    filtered = filtered.filter((m) => matchesScopeFilter(m, scope_filter));
  }

  // Filter out meta-facts from LLM extraction that describe the extraction process, not actual user facts
  const META_FACT_RE = /\b(the user (did not|provided|shared|mentioned|gave|is discussing|discussed|started a new topic|gave a|uploaded))\b/i;
  // Also filter garbage facts that are just file references or empty content
  const GARBAGE_FACT_RE = /^(pdf"|Fact:|-- \d+ of \d+ --|\s*$)/i;
  const cleanFiltered = filtered.filter(item => {
    const content = item.content || item.memory?.content || '';
    const title = item.title || item.memory?.title || '';
    // Exclude raw `promoted-from-segment` chunks — raw document sections promoted
    // verbatim. They belong to the evidence layer, not memory. They leak into this
    // HYBRID recall via the LEXICAL/FTS candidate path (which bypasses the Qdrant
    // layer/tag filter) as multi-hundred-char raw dumps. Memory recall = distilled
    // facts only. Source-agnostic chokepoint (covers lexical + vector + graph).
    const _tags = item.tags || item.memory?.tags || [];
    if (Array.isArray(_tags) && _tags.includes('promoted-from-segment')) return false;
    if (META_FACT_RE.test(content)) return false;
    // Filter facts that are just file/document references with no real content
    if (content.length < 40 && /\.(pdf|doc|txt|csv|xls)/i.test(content)) return false;
    // Filter facts that start with "pdf" or are page markers
    if (GARBAGE_FACT_RE.test(content.trim())) return false;
    return true;
  });

  // Pre-dedup entity-match boost. Without this, direct entity hits (e.g.
  // an SF Account record tagged entity:Vinil_Audit_AI_Inc) get collapsed
  // into richer-content synthesis memories during collapseNearDuplicates
  // because the synthesis row has higher base score and longer content.
  // Lifting the boost above dedup ensures the direct record wins the
  // preferCandidate tie and survives as the canonical representative.
  const _earlyQueryEntityTokens = _extractQueryEntityTokens(query_context);
  const _earlyEntityMatch = (item) => {
    if (_earlyQueryEntityTokens.length === 0) return item;
    const tags = item.memory?.tags || item.tags || [];
    if (!Array.isArray(tags) || tags.length === 0) return item;
    const entityNames = [];
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      if (t.startsWith('entity:') || t.startsWith('person:')) {
        { const raw = t.replace(/^(entity|person):/, ''); entityNames.push(normalizeEntity(raw) || raw.replace(/_/g, ' ').toLowerCase()); }
      }
    }
    if (entityNames.length === 0) return item;
    for (const tok of _earlyQueryEntityTokens) {
      for (const en of entityNames) {
        if (en === tok || en.includes(tok) || (tok.length >= 6 && tok.includes(en))) {
          return { ...item, score: (item.score || 0) * 1.8, _entity_match: true };
        }
      }
    }
    return item;
  };
  const entityBoostedPreDedup = cleanFiltered.map(_earlyEntityMatch);

  const deduped = collapseNearDuplicates(entityBoostedPreDedup, { preserveTemporalDistinctness: temporalComparison });

  // Apply fact-memory boost before slicing to contextLimit
  // Items have shape { memory, score, vectorScore, ... }
  // Recall reinforcement is allowed to affect ranking. Raw graph degree and
  // hub/bridge labels are not: duplicated/noisy edges must not create authority.
  const applyClusterBoost = (item) => {
    const mem = item.memory || item;
    const strength = Number.isFinite(mem.strength) ? mem.strength : 1.0;
    let mult = 1.0;
    mult *= (0.85 + 0.15 * Math.max(0.1, Math.min(1.0, strength)));
    return { ...item, score: (item.score || 0) * mult };
  };

  // Query-entity-tag match boost.
  // Surface direct entity hits above synthesis-bridge generic boosts. Without
  // this, a query like "Vinil Audit AI" returns canonical-fact + bridge
  // memories (1.35–1.50× synthesis boost) ahead of the actual Account /
  // Contact / Opportunity records, because those have no synthesis multiplier.
  // We extract proper-noun-shaped tokens from the query and check whether the
  // memory carries a matching `entity:<Name>` or `person:<Name>` tag. Exact
  // (or substring) match → ×1.8, which keeps named-entity recall sharp.
  const queryEntityTokens = _extractQueryEntityTokens(query_context);
  const applyEntityMatchBoost = (item) => {
    if (item._entity_match) return item; // already boosted ×1.8 in _earlyEntityMatch — never double-boost
    if (queryEntityTokens.length === 0) return item;
    const tags = item.memory?.tags || item.tags || [];
    if (!Array.isArray(tags) || tags.length === 0) return item;
    const entityNames = [];
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      if (t.startsWith('entity:') || t.startsWith('person:')) {
        { const raw = t.replace(/^(entity|person):/, ''); entityNames.push(normalizeEntity(raw) || raw.replace(/_/g, ' ').toLowerCase()); }
      }
    }
    if (entityNames.length === 0) return item;
    for (const tok of queryEntityTokens) {
      for (const en of entityNames) {
        if (en === tok || en.includes(tok) || (tok.length >= 6 && tok.includes(en))) {
          return { ...item, score: (item.score || 0) * 1.8, _entity_match: true };
        }
      }
    }
    return item;
  };

  // WorkingSet boost — surface memories aligned with what the user is
  // currently working on. Reads from the WorkingSet loaded earlier:
  //   - memory has entity tag in active_entities → ×1.30
  //   - memory tagged with active thread/channel/conversation → ×1.50
  //   - memory in active project → ×1.20
  //   - memory id is pinned → ×2.00 (hard pin)
  // Multiplicative with existing boosts. Cap stack at ×3.0 to avoid
  // pinned + entity + thread compounding into runaway scores.
  const applyWorkingSetBoost = (item) => {
    const mem = item.memory || item;
    const tags = mem.tags || [];
    let mult = 1.0;
    let matched = false;

    // Pinned wins everything else
    if (_wsPinned.size > 0 && mem.id && _wsPinned.has(String(mem.id))) {
      mult *= 2.0;
      matched = true;
    }

    if (_wsEntitiesLower.size > 0 && Array.isArray(tags)) {
      outer: for (const t of tags) {
        if (typeof t !== 'string') continue;
        if (!t.startsWith('entity:') && !t.startsWith('person:')) continue;
        const norm = t.replace(/^(entity|person):/, '').replace(/_/g, ' ').toLowerCase();
        for (const we of _wsEntitiesLower) {
          // Fuzzy: exact OR substring either direction (handles "Vinil" ↔ "Vinil Audit AI Anomalies")
          if (norm === we || norm.includes(we) || (we.length >= 4 && we.includes(norm))) {
            mult *= 1.3;
            matched = true;
            break outer;
          }
        }
      }
    }

    if (_wsThreads.size > 0 && Array.isArray(tags)) {
      for (const t of tags) {
        if (typeof t !== 'string') continue;
        if (t.startsWith('thread:') || t.startsWith('channel:') || t.startsWith('conversation:')) {
          const id = t.split(':').slice(1).join(':');
          if (_wsThreads.has(id)) { mult *= 1.5; matched = true; break; }
        }
      }
    }

    if (_wsProjects.size > 0 && mem.project && _wsProjects.has(mem.project)) {
      mult *= 1.2;
      matched = true;
    }

    // Tier 1 (thin) deboost — when both Tier 1 and Tier 2 share the same
    // anchor, the hot-cache row should win. Tier 1 stays in pool for
    // discovery but ranks below its hydrated counterpart.
    if (mem.tier === 1) mult *= 0.9;

    // Phase 2 top-down recall: boost governance-promoted cognitive layer
    // memories so they surface FIRST. canonical/bridge are Turing-verified
    // facts/edges — they encode the most distilled knowledge.
    const role = mem.cognitive_layer_role || mem.cognitiveLayerRole;
    // PHASE-A: principle layer is the most distilled tier — intentionally boosted
    // ABOVE canonical (1.7 > 1.6). Dark by default; a 'principle' role string matches
    // no existing branch when PRINCIPLES_RECALL_ENABLED is off, so OFF is byte-identical.
    if (role === 'principle' && PRINCIPLES_RECALL_ENABLED) mult *= 1.7;
    else if (role === 'canonical')   mult *= 1.6;
    else if (role === 'bridge') mult *= 1.4;
    else if (role === 'compression') mult *= 1.3;
    else if (role === 'reflection')  mult *= 1.1;

    if (mult >= 3.0) mult = 3.0;
    if (!matched && mem.tier !== 1 && !role) return item;
    return {
      ...item,
      score: (item.score || 0) * mult,
      _ws_match: !!matched,
      _cognitive_role: role || null,
    };
  };

  const applyItemBoosts = (items) => {
    let result = items.map(item => {
      const tags = item.memory?.tags || item.tags || [];
      const isFactMemory = Array.isArray(tags) && tags.includes('extracted-fact');
      let boosted = isFactMemory ? { ...item, score: (item.score || 0) * 1.15 } : item;
      boosted = applyExactSourceSummaryPenalty(boosted, exact_source);
      return applyWorkingSetBoost(applyEntityMatchBoost(applyClusterBoost(boosted)));
    });

    if (preference_boost) {
      result = result.map(item => {
        const type = item.memory?.memory_type || item.memory_type || '';
        const tags = item.memory?.tags || item.tags || [];
        const isPreference = type === 'preference'
          || (Array.isArray(tags) && tags.some(t => ['preference', 'personal', 'opinion'].includes(t)));
        const isObservation = type === 'observation';
        if (isPreference) return { ...item, score: (item.score || 0) * 1.6 };
        if (isObservation) return { ...item, score: (item.score || 0) * 1.25 };
        return item;
      });
    }

    return sortWithImportanceTiebreaker(result);
  };

  // Phase 1 cognition rework: query-aware synthesis gate.
  // Pre-compute query entity tokens once (reuse _earlyQueryEntityTokens
  // logic via _extractQueryEntityTokens). Synthesis boost only fires when
  // ≥1 query token overlaps a memory's entity tag — otherwise the boost
  // is the same flat multiplier regardless of relevance, which drowns
  // direct hits for unrelated topics (observed in 12h audit: bridges about
  // country:usa scored 1.5× for a Vinil query).
  const _querySynthTokens = _extractQueryEntityTokens(query_context);
  const _synthRelevant = (mem) => {
    if (_querySynthTokens.length === 0) return true; // no tokens → don't gate
    const tags = mem.tags || [];
    const names = [];
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      if (t.startsWith('entity:') || t.startsWith('person:') || t.startsWith('topic:')) {
        names.push(t.replace(/^(entity|person|topic):/, '').replace(/_/g, ' ').toLowerCase());
      }
    }
    if (names.length === 0) return false; // synthesis with no entity anchors → no boost
    for (const tok of _querySynthTokens) {
      for (const n of names) {
        if (n === tok || n.includes(tok) || (tok.length >= 6 && tok.includes(n))) return true;
      }
    }
    return false;
  };

  // ── Phase 1 Cognition Loop: synthesis boost ────────────────────────────────
  // canonical-fact ×1.35 when confidence ≥ 0.70
  // synthesis-bridge ×1.50 when confidence ≥ 0.70
  // Both get a further boost from recall count (reinforcement) and an age-decay
  // that pins high-recall memories as fresh regardless of age.
  const applySynthesisBoost = (items) => {
    return items.map(item => {
      const mem = item.memory || item;
      // Check both source_metadata.source_type AND tags (lexical path lacks source_metadata)
      let srcType = mem.source_metadata?.source_type || mem.sourceMetadata?.sourceType || mem.source_type || null;
      if (!srcType) {
        const tags = mem.tags || [];
        if (tags.includes('synthesis:canonical')) srcType = 'canonical-fact';
        else if (tags.includes('synthesis:bridge')) srcType = 'synthesis-bridge';
        // PHASE-A: principle layer (dark by default). Treated like canonical-fact below.
        else if (tags.includes('synthesis:principle') && PRINCIPLES_RECALL_ENABLED) srcType = 'principle';
      }
      const conf = typeof mem.synthesis_confidence === 'number'
        ? mem.synthesis_confidence
        : (typeof mem.synthesisConfidence === 'number' ? mem.synthesisConfidence : null);

      if (!srcType || conf === null) return item;
      // PHASE-A: 'principle' joins the eligible set (gated — OFF never produces it).
      if (srcType !== 'canonical-fact' && srcType !== 'synthesis-bridge' && srcType !== 'principle') return item;
      if (conf < SYNTHESIS_CONF_BOOST_FLOOR) return item;

      // Query-relevance gate. Synthesis boost only fires when query overlaps
      // synthesis cluster entities. Off-topic synthesis stays at base score.
      if (!_synthRelevant(mem)) return item;

      // Bridge stop-phrase gate. Reject schema-restatement confabulation.
      // Real bridges use contradict/confirm/extend/supersede verbs; LLM
      // confabulation uses "lack information", "available in cluster",
      // "data not present in". Bridges containing these phrases drop to
      // base score (no synthesis multiplier).
      if (srcType === 'synthesis-bridge') {
        const content = String(mem.content || '').toLowerCase();
        const STOP_PHRASES = [
          'lack information', 'lacks information', 'lack the information',
          'data is not present', 'not present in cluster',
          'available in cluster b', 'available in cluster a',
          'missing from cluster', 'creating an enabling gap',
        ];
        if (STOP_PHRASES.some((p) => content.includes(p))) return item;
      }

      // Source-type multiplier. PHASE-A: 'principle' treated like canonical-fact (1.35).
      let mult = (srcType === 'canonical-fact' || srcType === 'principle') ? 1.35 : 1.50;

      // Phase 2 — revision boost: each confirmed revision adds ×1.05 (capped at rev 6+)
      // rev1→×1.00, rev2→×1.05, rev3→×1.10, rev4→×1.15, rev5→×1.20, rev6+→×1.25
      // So canonical-fact rev5 = 1.35 × 1.20 = ×1.62; bridge rev5 = 1.50 × 1.20 = ×1.80
      const rev = mem.synthesis_revision || mem.synthesisRevision || 1;
      mult *= (1.0 + 0.05 * Math.min(5, Math.max(0, rev - 1)));

      // Recall-count reinforcement: small log boost for heavily-recalled memories
      const recallCount = mem.recall_count || mem.recallCount || 0;
      mult *= Math.max(0.5, Math.pow(recallCount + 1, 0.15));

      // Age decay — pin high-recall memories as fresh
      const created   = mem.created_at || mem.createdAt;
      const ageDays   = created
        ? (Date.now() - new Date(created).getTime()) / (1000 * 60 * 60 * 24)
        : 0;
      const recentRecalls = mem.recall_count_last_14d || 0;
      let ageMult;
      if (ageDays <= 7 || recentRecalls >= 3) {
        ageMult = 1.0; // fresh or actively recalled — no decay
      } else if (ageDays >= 60) {
        ageMult = 0.65; // cap at 60d
      } else {
        // linear decay from 1.0 at 7d to 0.65 at 60d
        ageMult = 1.0 - ((ageDays - 7) / (60 - 7)) * (1.0 - 0.65);
      }
      mult *= ageMult;

      return { ...item, score: (item.score || 0) * mult, _synthesis_boosted: true };
    });
  };

  const SYNTHESIS_CONF_BOOST_FLOOR = 0.70; // must match CONFIDENCE_FLOOR in cognition-loop.js

  const boostedItems = applySynthesisBoost(applyItemBoosts(deduped));
  if (_RLAP) _lap.score = Date.now() - _t0;

  // Update chain traversal: include older versions when superseded history is
  // wanted — either the caller asked (include_superseded) OR the query carries
  // time-travel / bi-temporal intent (auto-detected). traverseUpdateChain batches
  // its Updates lookups concurrently, so this lane stays cheap.
  let finalItems = boostedItems;
  let _versionTimeline = [];
  if (_wantVersionHistory) {
    const rawMemories = boostedItems.map(item => item.memory || item);
    const withSuperseded = await traverseUpdateChain(rawMemories, store, {
      user_id,
      org_id,
      project,
      valid_at: snapshotValidAt,
      known_at,
    });
    // Merge any newly added superseded memories back as scored items
    const existingIds = new Set(boostedItems.map(item => (item.memory || item).id));
    for (const mem of withSuperseded) {
      if (!existingIds.has(mem.id || mem.memory_id)) {
        const score = Number(mem.score) || 0;
        finalItems = [...finalItems, {
          memory: mem,
          score: temporalSnapshot ? score : score * 0.55,
          ...(!temporalSnapshot ? { _superseded_penalty: true } : {}),
        }];
      }
    }
    // (Time-travel version timeline is built later from the DELIVERED memories —
    // after rerank/head-slot/slice — since the reranker reorders the set.)
  }

  // Apply the authoritative bitemporal snapshot after chain expansion. This is
  // the single narrowing boundary for both current candidates and hydrated
  // historical versions; it uses structured metadata, never prose heuristics.
  if (temporalSnapshot) {
    finalItems = finalItems.filter((item) => isMemoryInTemporalSnapshot(
      item.memory || item,
      { validAt: snapshotValidAt, knownAt: known_at },
    ));
  }

  const missingPromotionImportance = finalItems.filter((item) => {
    const memory = item.memory || item;
    const memoryTags = Array.isArray(memory.tags) ? memory.tags : [];
    return memoryTags.includes('distilled-from-kb')
      && !Number.isFinite(Number(memory.importance_score ?? memory.importanceScore));
  });
  const prismaMemory = store.client?.memory || store.prisma?.memory;
  if (missingPromotionImportance.length && prismaMemory?.findMany) {
    try {
      const rows = await prismaMemory.findMany({
        where: { id: { in: missingPromotionImportance.map((item) => (item.memory || item).id) } },
        select: { id: true, importanceScore: true },
      });
      const importanceById = new Map(rows.map((row) => [row.id, row.importanceScore]));
      finalItems = finalItems.map((item) => {
        const memory = item.memory || item;
        if (!importanceById.has(memory.id)) return item;
        const hydrated = { ...memory, importance_score: importanceById.get(memory.id) };
        return item.memory ? { ...item, memory: hydrated } : hydrated;
      });
    } catch (error) {
      console.warn('[persisted-retrieval] promotion importance hydration failed:', error.message);
    }
  }

  // Caller-opts-in audit pass-through (e.g. /v1/governance UI). Else drop.
  const callerWantsAudit = Array.isArray(tags) && tags.some((t) => t === 'internal-audit');
  // Caller-opts-in hyper-room pass-through (e.g. /hivemind/app/swarm-rooms).
  const callerWantsRoomDecisions = Array.isArray(tags)
    && tags.some((t) => t === 'room-decision' || t === 'hyper-rooms');

  let top = finalItems
    .filter(item => {
      // Exclude benchmark data from production recall
      const tags = (item.memory || item).tags || [];
      if (!project && tags.includes('longmemeval')) return false;
      // Drop internal-audit (governance reflection rows etc.) unless
      // caller explicitly asked for them.
      if (!callerWantsAudit && tags.includes('internal-audit')) return false;
      // Drop hyper-room decisions from default recall — caller opts in.
      if (!callerWantsRoomDecisions
          && (tags.includes('room-decision') || tags.includes('hyper-rooms'))) return false;
      if (!isDurableKbPromotionAdmitted(item.memory || item, Number(process.env.KB_UNIFIED_MIN_IMPORTANCE || 0.65))) return false;
      return true;
    })
    .sort((a, b) => {
      // Apply requested sort mode
      if (sort === 'date_asc') {
        const dateA = new Date(a.memory?.document_date || a.document_date || a.memory?.created_at || a.created_at || 0);
        const dateB = new Date(b.memory?.document_date || b.document_date || b.memory?.created_at || b.created_at || 0);
        return dateA - dateB;
      }
      if (sort === 'date_desc') {
        const dateA = new Date(a.memory?.document_date || a.document_date || a.memory?.created_at || a.created_at || 0);
        const dateB = new Date(b.memory?.document_date || b.document_date || b.memory?.created_at || b.created_at || 0);
        return dateB - dateA;
      }
      // Deterministic: score desc + stable id tie-break (see merge-sort note above).
      return (b.score - a.score) || String(a.memory?.id || a.id || '').localeCompare(String(b.memory?.id || b.id || ''));
    })
    // RERANK WINDOW — keep a wide window (not just the delivered top-N) so the
    // rerankers below can surface a relevant row buried by score (e.g. a cross-
    // lingual exact match the bi-encoder ranks ~16th). Sliced to max_memories
    // AFTER reranking. This was the structural bug: old code sliced to
    // max_memories here, so rerankers only reordered the already-cut top-N.
    .slice(0, Math.min(finalItems.length, Math.max(max_memories * 6, 50)));

  if (sort !== 'date_asc' && sort !== 'date_desc') {
    top = sortWithImportanceTiebreaker(top);
  }

  // PHASE-B: tiered-view delivery reranking via the canonical algorithmic
  // ResultReranker (shared with three-tier-retrieval.js). Dark by default —
  // when RECALL_TIERED_VIEW is unset the inline score-sort above is the final
  // ordering and `top` is untouched. Re-ordering only; head-slot splice below
  // still runs afterwards so the canonical/bridge guarantee is preserved.
  const _tieredView = tiered_view != null ? !!tiered_view : TIERED_VIEW_ENABLED;
  if (_tieredView && top.length > 1) {
    // Normalize query_context to a string: the JSDoc types it as {string} but
    // callers can pass an object. ResultReranker._tokenize would coerce an
    // object to '[object Object]', nulling the BM25-like term-overlap signal.
    const rerankQuery = typeof query_context === 'string'
      ? query_context
      : (query_context?.text ?? query_context?.query ?? String(query_context));
    // PHASE-B: `top[]` items are wrapped as { memory, score, vectorScore, ... };
    // ResultReranker reads the flat fields `content`/`created_at`, which are
    // absent on the wrapper. Surface them from `item.memory` so the termOverlap
    // and recency signals are computed instead of silently degrading to 0.
    if (!_algorithmicReranker) _algorithmicReranker = new ResultReranker();
    top = _algorithmicReranker.rerank(
      rerankQuery,
      top.map((item) => ({
        ...item,
        content: item.memory?.content ?? item.content,
        created_at: item.memory?.created_at ?? item.created_at,
      }))
    );
  }

  // Cross-encoder rerank (Cohere v3.5, multilingual) over the wide window.
  // Recovers semantically-best rows the bi-encoder + term-overlap rank low,
  // especially cross-lingual (English query vs German fact). Graceful — keeps
  // order on any failure/timeout. Default-ON via RERANK_ENABLED (the env was
  // previously a no-op — the gate only honoured an explicit cross_rerank param,
  // so the Cohere reranker never fired on chat/recall/MCP despite the flag).
  // A per-call cross_rerank still overrides (true/false).
  const _crossRerank = cross_rerank != null ? !!cross_rerank : (process.env.RERANK_ENABLED === 'true');
  let _crossReranked = false;
  if (_crossRerank && top.length > 1) {
    try {
      const crq = typeof query_context === 'string'
        ? query_context
        : (query_context?.text ?? query_context?.query ?? String(query_context));
      const reranked = await crossEncoderRerank(
        crq,
        top.map((item) => ({ ...item, title: item.memory?.title ?? item.title, content: item.memory?.content ?? item.content })),
        { topN: top.length },
      );
      // The reranker returns the prior order on failure/disabled; only treat it
      // as authoritative when it actually scored rows (rerank_score present).
      if (Array.isArray(reranked) && reranked.length && reranked.some((r) => r.rerank_score != null)) {
        top = reranked;
        _crossReranked = true;
      }
    } catch (e) { /* graceful degrade — keep current order */ }
  }

  // NULLIFICATION BUG (fixed): this tiebreaker's first step is a FULL re-sort by
  // the old `.score`, which silently discarded the cross-encoder's ordering on
  // every call — the Cohere rerank ran, paid its latency, and had zero effect.
  // The cross-encoder order IS the final relevance order when it returns; the
  // importance tiebreaker applies only when the cross-encoder didn't run.
  if (!_crossReranked && sort !== 'date_asc' && sort !== 'date_desc') {
    top = sortWithImportanceTiebreaker(top);
  }

  // Deliver-narrow: slice the reranked WINDOW down to the requested count now
  // (the window was kept wide above so the rerankers could surface buried rows).
  top = top.slice(0, max_memories);

  // ── Head-slot: guarantee top synthesis candidate is first ─────────────────
  // When mode !== 'date_asc/date_desc' and the top synthesis candidate has a
  // boosted final score > 0.6 AND confidence ≥ 0.70, splice it to slot[0].
  // This ensures panorama/quick mode always surfaces the bridge/canonical first.
  // Guard: do NOT apply when query is date-specific (date_asc/date_desc sort
  // requested, or query contains an explicit date like "2026-05-14").
  const DATE_SPECIFIC_RE = /\b\d{4}-\d{2}-\d{2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/i;
  const isDateSpecificQuery = sort === 'date_asc' || sort === 'date_desc'
    || DATE_SPECIFIC_RE.test(query_context || '');

  if (!exact_source && !isDateSpecificQuery && top.length > 1) {
    const synthIdx = top.findIndex(item => {
      const mem = item.memory || item;
      let srcType = mem.source_metadata?.source_type || mem.sourceMetadata?.sourceType || null;
      if (!srcType) {
        const tags = mem.tags || [];
        if (tags.includes('synthesis:canonical')) srcType = 'canonical-fact';
        else if (tags.includes('synthesis:bridge')) srcType = 'synthesis-bridge';
        // PHASE-A: principle is head-slot eligible like canonical-fact (gated — OFF never produces it).
        else if (tags.includes('synthesis:principle') && PRINCIPLES_RECALL_ENABLED) srcType = 'principle';
      }
      const conf = typeof mem.synthesis_confidence === 'number' ? mem.synthesis_confidence
        : (typeof mem.synthesisConfidence === 'number' ? mem.synthesisConfidence : null);
      // C2: never promote a SUPERSEDED synthesis to slot[0]. A demoted synthesis
      // (is_latest=false) re-entering the pool (e.g. via traverseUpdateChain under
      // include_superseded) can out-score its fresh replacement on the
      // revision/recall boost; without this guard it buries the current head.
      // (camelCase isLatest / snake_case is_latest both surface depending on path.)
      const isLatest = mem.is_latest !== undefined ? mem.is_latest : mem.isLatest;
      if (isLatest === false) return false;
      return (srcType === 'canonical-fact' || srcType === 'synthesis-bridge' || srcType === 'principle')
        && conf !== null && conf >= 0.70
        && (item.score || 0) > 0.6;
    });
    if (synthIdx > 0) {
      const [synth] = top.splice(synthIdx, 1);
      top.unshift(synth);
    }
  }
  // Observation prefix (Mastra-style stable context) — kicked off at the top of
  // this function (parallel with the whole pipeline) since it depends only on
  // (user, org, project). Resolve it now; already settled in the common case.
  let observationPrefix = '';
  let hasObservations = false;
  try {
    const { prefix, observationCount } = await _observationPrefixPromise;
    if (observationCount >= 3) {
      observationPrefix = prefix;
      hasObservations = true;
    }
  } catch {
    // Observation prefix not available — fall through to standard retrieval
  }
  if (_RLAP) _lap.obs = Date.now() - _t0;

  let injectionText;
  try {
    const { formatChainOfNotePayload } = await import('./operator-layer.js');
    injectionText = formatChainOfNotePayload(top.map(item => item.memory || item), query_context || '');
  } catch {
    injectionText = `<relevant-memories>\n${top.map(item => `- ${(item.memory || item).content}`).join('\n')}\n</relevant-memories>`;
  }

  if (hasObservations) {
    // Include original raw chunks alongside observations (Supermemory pattern)
    const rawSupplementary = top.slice(0, 3)
      .map(item => (item.memory || item).content || '')
      .filter(c => c.length > 20)
      .join('\n---\n');

    const supplement = rawSupplementary
      ? `\n\n<raw-context>\n${rawSupplementary}\n</raw-context>`
      : '';

    injectionText = observationPrefix + supplement + '\n\n' + injectionText;
  }

  // Inject user profile (static facts) — kicked off at the top, parallel with
  // the pipeline; resolve it here.
  try {
    const { profile: userProfileText } = await _userProfilePromise;
    if (userProfileText) {
      injectionText = userProfileText + '\n\n' + injectionText;
    }
  } catch {
    // User profile not available
  }
  if (_RLAP) _lap.profile = Date.now() - _t0;

  // ── Build flat memories[] (backwards-compat) + synthesized[]/raw[] (new) ──
  const flatMemories = top.map(item => ({
    ...item.memory,
    score:            item.score,
    vector_score:     item.vectorScore || 0,
    keyword_score:    item.keywordScore || 0,
    graph_score:      item.graphScore || 0,
    policy_score:     item.policyScore || 0,
    graph_expanded:   item.graph_expanded || false,
    expansion_metadata: item.expansion_metadata || null,
    _synthesis_boosted: item._synthesis_boosted || false,
    // Phase A/B observability — surface so caller can see which boosts fired
    ...(item._entity_match ? { _entity_match: true } : {}),
    ...(typeof item._ws_match === 'boolean' ? { _ws_match: item._ws_match } : {}),
  }));

  // ── Time-travel / bi-temporal version timeline ────────────────────────────
  // Built from the DELIVERED memories (post rerank/head-slot/slice) since the
  // reranker reorders vs the pre-slice pool. Walk each delivered fact's Updates
  // chain straight from the DB (authoritative; from=newer → to=older), then
  // batch-hydrate content (NO deletedAt filter — superseded rows are soft-deleted
  // and are exactly the history we want). Gated on _timeTravelIntent → for normal
  // queries this whole block is skipped (zero added latency, shape unchanged).
  if (_timeTravelIntent) {
    try {
      const MAX_CHAINS = 5, MAX_VERSIONS = 8;
      const _p = store.client || store.prisma;
      const baseIds = flatMemories.slice(0, 8).map(m => m && m.id).filter(Boolean);
      if (baseIds.length && _p?.relationship?.findMany && _p?.memory?.findMany) {
        const updatesFrom = new Map();
        const allIds = new Set(baseIds);
        let frontier = baseIds;
        for (let hop = 0; hop < 3 && frontier.length; hop++) {
          const edges = await _p.relationship.findMany({
            where: { fromId: { in: frontier }, type: 'Updates' },
            select: { fromId: true, toId: true },
          }).catch(() => []);
          const next = [];
          for (const e of edges) {
            if (!updatesFrom.has(e.fromId)) updatesFrom.set(e.fromId, []);
            updatesFrom.get(e.fromId).push(e.toId);
            if (!allIds.has(e.toId)) { allIds.add(e.toId); next.push(e.toId); }
          }
          frontier = next;
        }
        const vrows = await _p.memory.findMany({
          where: { id: { in: [...allIds] } },
          select: { id: true, content: true, createdAt: true },
        }).catch(() => []);
        const vById = new Map(vrows.map(r => [r.id, r]));
        const walk = (start) => {
          const ids = [start]; const seen = new Set([start]); let cur = start;
          while (ids.length < MAX_VERSIONS + 6) {
            const nx = (updatesFrom.get(cur) || []).find(x => !seen.has(x));
            if (!nx) break;
            seen.add(nx); ids.push(nx); cur = nx;
          }
          return ids;
        };
        const claimed = new Set();
        for (const base of baseIds) {
          if (claimed.has(base)) continue;
          const ids = walk(base);
          if (ids.length <= 1) continue;
          const versions = ids
            .map(id => { const r = vById.get(id); return r && r.content ? { id, content: r.content, created_at: r.createdAt, is_latest: id === base } : null; })
            .filter(Boolean)
            .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)) // newest → oldest
            .slice(0, MAX_VERSIONS);
          if (versions.length > 1) {
            ids.forEach(x => claimed.add(x));
            _versionTimeline.push({ memory_id: base, versions });
            if (_versionTimeline.length >= MAX_CHAINS) break;
          }
        }
      }
    } catch (_) { /* timeline is additive — never fail recall on it */ }
  }

  // Synthesized array: rich rendering for canonical-fact and synthesis-bridge outputs.
  // In quick mode: top synthesis entry + top-2 of its synthesisEvidenceIds (3–4 total).
  //
  // NOTE: lexical candidates from searchMemories() return a bare object without
  // source_metadata (the FTS SQL branch only returns content/title/tags/score).
  // Vector candidates come from store.getMemory() and have source_metadata attached.
  // To handle both paths reliably, check tags for synthesis:canonical / synthesis:bridge
  // in addition to source_metadata.source_type.
  const isSynthesisMemory = (m) => {
    const srcType = m.source_metadata?.source_type || m.sourceMetadata?.sourceType || null;
    if (srcType === 'canonical-fact' || srcType === 'synthesis-bridge') return true;
    const tags = m.tags || [];
    return tags.includes('synthesis:canonical') || tags.includes('synthesis:bridge');
  };

  const getSynthesisSourceType = (m) => {
    const srcType = m.source_metadata?.source_type || m.sourceMetadata?.sourceType || null;
    if (srcType === 'canonical-fact' || srcType === 'synthesis-bridge') return srcType;
    const tags = m.tags || [];
    if (tags.includes('synthesis:canonical')) return 'canonical-fact';
    if (tags.includes('synthesis:bridge')) return 'synthesis-bridge';
    return null;
  };

  const synthesizedItems = flatMemories.filter(m => isSynthesisMemory(m));
  const rawItems         = flatMemories.filter(m => !isSynthesisMemory(m));

  // Preserve the historic rich-recall behaviour by default, but let callers
  // such as grounded chat opt out.  `null` deliberately follows
  // include_injection_context for backwards compatibility.
  const hydrateSynthesisEvidence = include_synthesis_evidence == null
    ? include_injection_context === true
    : include_synthesis_evidence === true;

  // Fetch all needed source rows in ONE batch.  The previous implementation
  // did Promise.all(synthesis rows × five source ids), which can turn a
  // perfectly valid recall into 30+ concurrent remote hydrations.  Remote
  // Memory Boxes correctly bound their transport queue; chat then saw noisy
  // queue-full warnings for data it did not consume.
  const synthesisEvidenceIds = hydrateSynthesisEvidence
    ? [...new Set(synthesizedItems.flatMap((memory) => {
      const ids = memory.synthesis_evidence_ids || memory.synthesisEvidenceIds || [];
      return Array.isArray(ids) ? ids.slice(0, 5).filter(Boolean) : [];
    }))].slice(0, 80)
    : [];
  let synthesisEvidenceById = new Map();
  if (synthesisEvidenceIds.length && store?.getMemories) {
    try {
      synthesisEvidenceById = await store.getMemories(synthesisEvidenceIds);
    } catch {
      // Rich card enrichment is optional.  Never degrade the canonical recall
      // result merely because its supporting preview could not be hydrated.
      synthesisEvidenceById = new Map();
    }
  }

  // Build evidence snippets for synthesized items from synthesisEvidenceIds
  const buildEvidenceSnippets = (synthMem) => {
    const evidenceIds = synthMem.synthesis_evidence_ids || synthMem.synthesisEvidenceIds || [];
    if (!hydrateSynthesisEvidence || !Array.isArray(evidenceIds) || !evidenceIds.length) return [];
    return evidenceIds.slice(0, 5)
      .map((id) => synthesisEvidenceById.get(id))
      .filter(Boolean)
      .map(e => ({
        id:      e.id,
        title:   e.title || null,
        snippet: (e.content || '').slice(0, 200),
      }));
  };

  // Enrich synthesized items with evidence snippets (async but bounded)
  const synthesized = await Promise.all(synthesizedItems.map(async m => {
    const srcType  = getSynthesisSourceType(m);
    const conf     = typeof m.synthesis_confidence === 'number' ? m.synthesis_confidence
      : (typeof m.synthesisConfidence === 'number' ? m.synthesisConfidence : null);
    const revision = m.synthesis_revision || m.synthesisRevision || 1;
    const evidence = buildEvidenceSnippets(m);
    return {
      id:         m.id,
      type:       srcType,
      claim:      m.content,
      title:      m.title,
      confidence: conf,
      revision,
      evidence,
      score:      m.score,
      tags:       m.tags || [],
      created_at: m.created_at,
    };
  }));

  const timingBreakdown = _RLAP ? {
    fetch_ms: _lap.fetch ?? null,
    graph_expand_ms: (_lap.expand ?? 0) - (_lap.fetch ?? 0),
    score_fusion_ms: (_lap.score ?? 0) - (_lap.expand ?? 0),
    delivery_ms: (_lap.obs ?? _lap.score ?? 0) - (_lap.score ?? 0),
    profile_ms: (_lap.profile ?? _lap.obs ?? 0) - (_lap.obs ?? 0),
    synthesis_format_ms: (Date.now() - _t0) - (_lap.profile ?? _lap.obs ?? _lap.score ?? 0),
    total_ms: Date.now() - _t0,
    ...(timing || {}),
  } : null;
  if (_LOG_LAP) {
    _lap.total = Date.now() - _t0;
    // Derived per-stage: front-fetch | expand | sync-score | tail(rerank/operator/format)
    console.log('[recall-lap]', JSON.stringify({
      ..._lap,
      d_expand: (_lap.expand ?? 0) - (_lap.fetch ?? 0),
      d_score: (_lap.score ?? 0) - (_lap.expand ?? 0),
      d_deliver: (_lap.obs ?? _lap.score ?? 0) - (_lap.score ?? 0), // rerank/headslot/format + obs-await
      d_profile: (_lap.profile ?? _lap.obs ?? 0) - (_lap.obs ?? 0),
      d_synth: (_lap.total ?? 0) - (_lap.profile ?? _lap.obs ?? _lap.score ?? 0),
      d_tail: (_lap.total ?? 0) - (_lap.score ?? 0),
    }));
    // Wide-memory funnel: how many candidates each parallel lane fetched →
    // merged pool → final delivered. Shows "search wide, rank narrow".
    console.log('[recall-funnel]', JSON.stringify({
      lanes: {
        lexical: Array.isArray(filteredLexical) ? filteredLexical.length : 0,
        vector: Array.isArray(vectorCandidates) ? vectorCandidates.length : 0,
        crosslingual: Array.isArray(crosslingualCandidates) ? crosslingualCandidates.length : 0,
        entity: Array.isArray(entityFilteredCandidates) ? entityFilteredCandidates.length : 0,
        entity_hop0: entityHop0Candidates.length,
        entity_hop0_matched: Array.isArray(_entityHop0?.matchedEntities) ? _entityHop0.matchedEntities.length : 0,
        entity_hop0_ms: _entityHop0?.latencyMs || 0,
        temporal: Array.isArray(temporalFilteredCandidates) ? temporalFilteredCandidates.length : 0,
        graph_expanded: Array.isArray(expandedCandidates) ? expandedCandidates.length : 0,
      },
      merged_pool: Array.isArray(boostedItems) ? boostedItems.length : 0,
      delivered: Array.isArray(flatMemories) ? flatMemories.length : 0,
      synthesized: Array.isArray(synthesized) ? synthesized.length : 0,
      timeline_chains: _versionTimeline.length,
    }));
  }

  return {
    // Backwards-compat flat array (synthesized first, then raw so existing clients work)
    memories: flatMemories,
    // New rich arrays for v2 clients
    synthesized,
    raw: rawItems,
    injectionText,
    search_method: vectorCandidates.length > 0 ? 'persisted-hybrid' : 'persisted-keyword',
    expansion_stats: {
      expanded_count:   expandedCandidates.length,
      included_count:   top.filter(item => item.graph_expanded).length,
      synthesis_count:  synthesized.length,
    },
    ...(trace_stages ? { timing_breakdown: timingBreakdown } : {}),
    // PHASE-B: tiered "recall spine" view. Additive + dark by default — the key is
    // absent entirely unless RECALL_TIERED_VIEW=true, so legacy clients see the
    // byte-identical shape. memories/synthesized/raw kept for backcompat.
    ...(TIERED_VIEW_ENABLED ? { spine: buildRecallSpine(flatMemories, synthesized) } : {}),
    // Time-travel / bi-temporal lane output: present only when the query had
    // history/as-of intent AND a versioned chain was found. Each entry is one
    // fact's chronological version history (oldest→newest) so the answer can
    // state how it changed. Absent for ordinary queries (byte-identical shape).
    ...(_versionTimeline.length ? { timeline: _versionTimeline, time_travel: true } : {}),
  };
}

// ─── Cross-cluster shared-entity boost ────────────────────────────────────────
/**
 * Post-rerank pass: after RRF merge, before final slice.
 *
 * For each candidate memory carrying a synthesisClusterHash, count how many
 * OTHER clusters in the same result set share at least one entity key.
 * Boost up to ×1.30, with an extra +0.05 if any overlapping cluster has
 * latestConfidence ≥ 0.85.
 *
 * Uses ClusterIndex.prisma directly (passed as clusterIndex arg) so we avoid
 * loading ClusterIndex class here — caller injects it.
 *
 * Never throws — errors are silently suppressed so recall is never blocked.
 *
 * @param {Array}  memories        Ranked memory array (mutated in-place then re-sorted)
 * @param {object} opts
 * @param {object} opts.clusterIndex  ClusterIndex instance
 * @param {string} opts.organizationId
 * @returns {Promise<Array>}  Same array, re-sorted by score descending
 */
export async function crossClusterEntityBoost(memories, { clusterIndex, organizationId }) {
  try {
    const withCluster = memories.filter(m => m.synthesisClusterHash || m.synthesis_cluster_hash);
    if (withCluster.length < 2) return memories;

    const hashes = [...new Set(withCluster.map(m => m.synthesisClusterHash || m.synthesis_cluster_hash))];

    const rows = await clusterIndex.prisma.clusterIndex.findMany({
      where: { organizationId, clusterHash: { in: hashes } },
      select: { clusterHash: true, entityKeys: true, latestConfidence: true },
    });

    if (rows.length < 2) return memories; // no cross-cluster data

    const byHash = new Map(rows.map(r => [r.clusterHash, r]));

    for (const m of memories) {
      const ch = m.synthesisClusterHash || m.synthesis_cluster_hash;
      if (!ch) continue;
      const my = byHash.get(ch);
      if (!my || !my.entityKeys?.length) continue;
      const myEntSet = new Set(my.entityKeys);
      let overlap = 0;
      let highConfNeighbor = false;
      for (const other of rows) {
        if (other.clusterHash === ch) continue;
        const shared = other.entityKeys.filter(e => myEntSet.has(e));
        if (shared.length > 0) {
          overlap += 1;
          if ((Number(other.latestConfidence) || 0) >= 0.85) highConfNeighbor = true;
        }
      }
      if (overlap === 0) continue;
      const boost = 1 + Math.min(0.30, 0.10 * overlap) + (highConfNeighbor ? 0.05 : 0);
      m.score = (m.score || 0) * boost;
      m._cross_cluster_boost = boost;
      m._cross_cluster_overlap = overlap;
    }

    // Re-sort by score descending after mutation
    return memories.sort((a, b) => (b.score || 0) - (a.score || 0));
  } catch (err) {
    // Non-fatal — never block recall on metric/boost failure
    console.warn('[persisted-retrieval] crossClusterEntityBoost failed:', err.message);
    return memories;
  }
}

// Extract proper-noun-shaped tokens from a query string for entity-tag
// matching. Handles:
//   • multi-word capitalized phrases  → "Vinil Audit AI"  → "vinil audit ai"
//   • single capitalized 4+ char tokens → "Salesforce" → "salesforce"
//   • bare lowercase 4+ char tokens when the query has no capitalization
//     (covers all-lowercase user input like "vinil audit ai pilot")
// Map query text → candidate `entity:<Token>` / `person:<Token>` tag forms that
// mirror the INGEST-side normalization (graph-engine.js: `entity:` + name with
// spaces→underscores, ORIGINAL case). The query extractor lowercases (loses
// case), and ingest preserves case — so for an EXACT Qdrant keyword match we
// must emit several case variants per token as OR (`should`) candidates:
// original-extracted, lowercased, Title_Case. This is the G1 surface — its real
// hit-rate is measured by the extraction-symmetry invariant test before any
// flip to ENTITY_FILTER_MODE=must.
export function normalizeQueryEntityTokens(query) {
  if (!query || typeof query !== 'string') return [];
  const out = new Set();
  // Case-PRESERVING extraction (the lowercase _extractQueryEntityTokens can't
  // reconstruct 'Amar_Sai_Gadde' from 'amar sai gadde').
  const capPhrases = query.match(/[A-Z][\w&]+(?:\s+[A-Z][\w&]+)+/g) || [];
  const singletons = query.match(/\b[A-Z][\w&]{3,}\b/g) || [];
  const raw = [...capPhrases, ...singletons];
  const titleCase = (s) => s.split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join('_');
  for (const term of raw) {
    const us = term.trim().replace(/\s+/g, '_');
    if (!us) continue;
    for (const prefix of ['entity:', 'person:']) {
      out.add(prefix + us);                       // as-extracted
      out.add(prefix + us.toLowerCase());          // lowercased
      out.add(prefix + titleCase(term.trim()));    // Title_Case
    }
  }
  return Array.from(out);
}

// Map query text → candidate `ts:YYYY-MM-DD` / `time:YYYY-MM-DD` / `time:<dayname>`
// tag forms that mirror the INGEST-side temporal stamps:
//   - graph-engine deterministic stamp: `ts:YYYY-MM-DD` (every memory)
//   - entity-co-mention LLM:            `time:YYYY-MM-DD` (date_iso) + `time:<dow>`
// So for a date-anchored query ("yesterday", "last week", "on Monday",
// explicit 2026-06-09) we emit BOTH `ts:` and `time:` forms as OR (`should`)
// candidates. All date math is UTC to match the ingest stamp (which uses
// `toISOString().slice(0,10)`). `nowMs` is injected so callers/tests are
// deterministic. Returns [] when the query carries no temporal anchor — so the
// additive pass is a no-op for non-temporal queries (zero cost).
const _DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const _DAY_MS = 86400000;
export function normalizeQueryTemporalTokens(query, nowMs) {
  if (!query || typeof query !== 'string') return [];
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const q = query.toLowerCase();
  const out = new Set();
  const fmtDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  const dowOf = (ms) => _DOW[new Date(ms).getUTCDay()];
  const addDate = (ms) => { const d = fmtDay(ms); out.add(`ts:${d}`); out.add(`time:${d}`); };
  const addDowDate = (ms) => { addDate(ms); out.add(`time:${dowOf(ms)}`); };

  // ── Relative anchors ──
  if (/\btoday(?:'?s)?\b|\bthis morning\b|\bthis afternoon\b|\btonight\b/.test(q)) addDowDate(now);
  if (/\byesterday\b/.test(q)) addDowDate(now - _DAY_MS);
  if (/\btomorrow\b/.test(q)) addDowDate(now + _DAY_MS);
  // "last/past week" → trailing 7 days; "this week" → current day + 6 prior.
  if (/\b(last|past|previous|prior)\s+week\b/.test(q)) {
    for (let i = 1; i <= 7; i++) addDate(now - i * _DAY_MS);
  }
  if (/\bthis\s+week\b/.test(q)) {
    for (let i = 0; i <= 6; i++) addDate(now - i * _DAY_MS);
  }
  // "last/past month" → trailing 31 days (no month-prefix tag exists to OR).
  if (/\b(last|past|previous|prior)\s+month\b/.test(q)) {
    for (let i = 1; i <= 31; i++) addDate(now - i * _DAY_MS);
  }
  if (/\brecently\b|\blately\b|\bpast few days\b|\blast few days\b/.test(q)) {
    for (let i = 0; i <= 3; i++) addDate(now - i * _DAY_MS);
  }

  // ── Day-of-week mentions ("on monday", "monday", "fri") → the dow tag plus
  //    the most-recent occurrence (today if it matches, else the prior one). ──
  for (let d = 0; d < 7; d++) {
    const name = _DOW[d];
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(q)) {
      out.add(`time:${name}`);
      const diff = (new Date(now).getUTCDay() - d + 7) % 7; // 0 = today
      addDate(now - diff * _DAY_MS);
    }
  }

  // ── Explicit ISO date(s) in the query (YYYY-MM-DD) ──
  const isoDates = q.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
  for (const d of isoDates) { out.add(`ts:${d}`); out.add(`time:${d}`); }

  return Array.from(out);
}

function _extractQueryEntityTokens(query) {
  if (!query || typeof query !== 'string') return [];
  const out = new Set();

  // Multi-word capitalized phrases
  const capPhrases = query.match(/[A-Z][\w&]+(?:\s+[A-Z][\w&]+)+/g) || [];
  for (const p of capPhrases) out.add(p.toLowerCase());

  // Singleton capitalized 4+ chars
  const singletons = query.match(/\b[A-Z][\w&]{3,}\b/g) || [];
  for (const s of singletons) out.add(s.toLowerCase());

  // Fallback for all-lowercase queries: bigrams + 4+ char content tokens
  if (out.size === 0) {
    const STOP = new Set(['what','when','where','which','that','this','with','from',
      'about','have','their','they','then','show','find','tell','give','status',
      'pilot','project','update','recent','latest','current','please','help']);
    const words = query.toLowerCase().match(/[a-z][a-z0-9&]{3,}/g) || [];
    const meaningful = words.filter((w) => !STOP.has(w));
    for (const w of meaningful) out.add(w);
    // Adjacent bigrams (catches "vinil audit", "cherry ventures")
    for (let i = 0; i < meaningful.length - 1; i++) {
      out.add(`${meaningful[i]} ${meaningful[i + 1]}`);
    }
  }

  // Canonicalize query-derived entity tokens through the SAME normalizer used
  // on stored entity: tags, so "SOLVIS" matches the canonical entity:solvis.
  // Keep the raw form too (fallback) so the fuzzy substring path still fires.
  const canon = new Set();
  for (const t of out) {
    canon.add(t);
    const n = normalizeEntity(t);
    if (n) {
      canon.add(n);
      // Also add hyphen-split parts so a multi-word query ("solvis portal" →
      // "solvis-portal") still matches a single-word stored entity ("solvis").
      if (n.includes('-')) for (const part of n.split('-')) if (part.length >= 3) canon.add(part);
    }
  }
  return Array.from(canon);
}

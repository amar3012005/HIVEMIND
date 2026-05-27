import { computeTokenSimilarity } from './conflict-detector.js';
import { getQdrantClient } from '../vector/qdrant-client.js';
import { expandTemporalQuery } from '../search/time-aware-expander.js';

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
  const content = memory.content || '';
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

function buildCollectionName(userId) {
  return process.env.QDRANT_COLLECTION || 'BUNDB AGENT';
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

function lexicalCoverage(leftContent = '', rightContent = '') {
  const left = tokenSet(leftContent);
  const right = tokenSet(rightContent);
  if (left.size === 0 || right.size === 0) return 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  let overlap = 0;
  for (const token of smaller) {
    if (larger.has(token)) overlap += 1;
  }
  return overlap / smaller.size;
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
  const similarity = computeTokenSimilarity(left.memory.content || '', right.memory.content || '');
  if (similarity >= 0.85) return true;

  // Extracted facts with same title prefix are likely duplicates from chunked documents
  const leftTitle = (left.memory.title || '').slice(0, 40);
  const rightTitle = (right.memory.title || '').slice(0, 40);
  if (leftTitle && leftTitle === rightTitle && similarity >= 0.60) return true;

  // Same score AND similar content = likely duplicate from same source
  if (Math.abs((left.score || 0) - (right.score || 0)) < 0.01 && similarity >= 0.70) return true;

  const sameSourcePlatform = (left.memory.source_metadata?.source_platform || left.memory.source)
    && (left.memory.source_metadata?.source_platform || left.memory.source) === (right.memory.source_metadata?.source_platform || right.memory.source);
  const coverage = lexicalCoverage(left.memory.content || '', right.memory.content || '');
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

function applyRecallRelevanceFloor(scored, options = {}) {
  const { temporalComparison = false } = options;
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
  if (viable.length === 0) return [];

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
 * Reciprocal Rank Fusion (RRF) — merges multiple ranked lists by rank position,
 * not raw scores. This handles the problem of different score scales across
 * vector, lexical, and graph results. Borrowed from code-review-graph's approach.
 *
 * RRF score = sum(1 / (k + rank + 1)) across all lists an item appears in.
 */
function rrfMerge(lists, k = 60) {
  const scores = new Map();
  const items = new Map();

  for (const list of lists) {
    if (!list) continue;
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      if (!item?.memory?.id) continue;
      const id = item.memory.id;
      scores.set(id, (scores.get(id) || 0) + 1.0 / (k + rank + 1));
      if (!items.has(id)) {
        items.set(id, { ...item });
      } else {
        // Merge metadata: keep the richer version
        const existing = items.get(id);
        items.set(id, {
          ...existing,
          memory: existing.memory || item.memory,
          vectorScore: Math.max(existing.vectorScore || 0, item.vectorScore || 0),
          keywordScore: Math.max(existing.keywordScore || 0, item.keywordScore || 0),
          graphScore: Math.max(existing.graphScore || 0, item.graphScore || 0),
          similarityScore: Math.max(existing.similarityScore || 0, item.similarityScore || 0),
          recencyScore: Math.max(existing.recencyScore || 0, item.recencyScore || 0),
        });
      }
    }
  }

  // Apply RRF scores
  const merged = [];
  for (const [id, rrfScore] of scores) {
    const item = items.get(id);
    if (item) {
      merged.push({ ...item, score: rrfScore, _rrfScore: rrfScore });
    }
  }

  return merged.sort((a, b) => b.score - a.score);
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

// Build a set of memory ids that are TARGETS of any Contradicts edge.
// Used by recall scoring to apply a relevance penalty — a memory the
// graph flagged as contradicted should rarely beat its successor.
function buildContradictedIndex(relationships) {
  const targets = new Set();
  for (const edge of relationships) {
    if (edge.type === 'Contradicts' && edge.to_id) targets.add(edge.to_id);
  }
  return targets;
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

function parseDateRangeBoundary(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isMemoryInDateRange(memory, dateRange) {
  if (!dateRange) return true;

  const start = parseDateRangeBoundary(dateRange.start);
  const end = parseDateRangeBoundary(dateRange.end);
  const candidateDates = [
    memory.document_date,
    memory.created_at,
    memory.metadata?.record_time,
    memory.metadata?.event_time,
    memory.metadata?.valid_from,
    memory.metadata?.valid_to
  ]
    .map(parseDateRangeBoundary)
    .filter(Boolean);

  if (candidateDates.length === 0) return false;

  return candidateDates.some(date => {
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  });
}

async function vectorCandidatesForRecall(store, {
  query_context,
  user_id,
  org_id,
  project,
  source_platforms = [],
  tags = [],
  max_memories,
  dateRange = null,
  scoreThreshold = 0.25,
  candidatePoolSize = Math.max(max_memories * 4, 20),
  is_latest = true,
  access_context = null,
  scope_filter = null,
}) {
  const qdrantClient = getQdrantClient();
  const connected = await qdrantClient.isConnected();
  if (!connected) {
    return [];
  }

  const results = await qdrantClient.hybridSearch(query_context, {
    user_id,
    org_id,
    project,
    tags,
    is_latest,
    limit: candidatePoolSize,
    score_threshold: scoreThreshold,
    collectionName: buildCollectionName(user_id)
  });

  const hydrated = await Promise.all((results || []).map(async result => {
    const sourcePlatform = result.payload?.source_platform || result.payload?.source || null;
    if (source_platforms.length > 0 && !source_platforms.includes(sourcePlatform)) {
      return null;
    }

    const memoryId = result.payload?.memory_id || result.id;
    const memory = await store.getMemory(memoryId);
    if (!memory) return null;
    if (!isMemoryInDateRange(memory, dateRange)) return null;
    // V2 scope filtering: enforce after hydrate (vector index doesn't carry scope)
    if (access_context) {
      const m = memory;
      const ok =
        (m.scope === 'personal' && m.user_id === user_id) ||
        (m.scope === 'organization' && m.org_id === org_id) ||
        (m.scope === 'team' && (access_context.teamIds || []).includes(m.primary_team_id)) ||
        (m.scope === 'project' && Array.isArray(m.project_ids) &&
           m.project_ids.some(pid => (access_context.projectIds || []).includes(pid)));
      if (!ok) return null;
    }
    if (scope_filter && memory.scope && memory.scope !== scope_filter) return null;

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
  }));

  return hydrated.filter(item => {
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

export async function queryPersistedMemories(store, { pattern, user_id, org_id, project, ...params }) {
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
// Boost fact-memories (extracted-fact tags) — they have focused, precise embeddings
function boostFactMemories(memories) {
  return memories.map(mem => {
    const tags = mem.tags || mem.payload?.tags || [];
    const isFactMemory = Array.isArray(tags) && tags.includes('extracted-fact');
    if (isFactMemory) {
      return { ...mem, score: (mem.score || 0) * 1.15 };
    }
    return mem;
  }).sort((a, b) => (b.score || 0) - (a.score || 0));
}

function boostPreferenceMemories(memories, options = {}) {
  if (!options.preference_boost) return memories;

  return memories.map(mem => {
    const type = mem.memory_type || mem.payload?.memory_type || '';
    const tags = mem.tags || mem.payload?.tags || [];

    const isPreference = type === 'preference'
      || (Array.isArray(tags) && tags.some(t => ['preference', 'personal', 'opinion'].includes(t)));
    const isObservation = type === 'observation';

    if (isPreference) return { ...mem, score: (mem.score || 0) * 1.6 };
    if (isObservation) return { ...mem, score: (mem.score || 0) * 1.25 };
    return mem;
  }).sort((a, b) => (b.score || 0) - (a.score || 0));
}

async function traverseUpdateChain(memories, store, { maxDepth = 3 } = {}) {
  if (!store || !memories?.length) return memories;

  const expanded = [...memories];
  const seen = new Set(memories.map(m => m.id || m.memory_id));

  for (const mem of memories) {
    try {
      const memId = mem.id || mem.memory_id;
      if (!memId) continue;

      // Find memories linked via Updates relationship (older versions)
      const related = await store.getRelatedMemories?.(memId, { type: 'Updates', depth: maxDepth });
      if (!related?.length) continue;

      for (const rel of related) {
        const relId = rel.id || rel.memory_id;
        if (relId && !seen.has(relId)) {
          seen.add(relId);
          expanded.push({ ...rel, score: (rel.score || 0) * 0.7 }); // lower score for old versions
        }
      }
    } catch (_) {
      // skip on error
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
  const relationshipTypes = ['Derives', 'Extends', 'Updates'];

  // Build relationship lookup for quick access to edge metadata
  const relationshipLookup = new Map();
  for (const edge of relationships) {
    const key = `${edge.from_id}-${edge.to_id}`;
    relationshipLookup.set(key, edge);
    const reverseKey = `${edge.to_id}-${edge.from_id}`;
    if (!relationshipLookup.has(reverseKey)) {
      relationshipLookup.set(reverseKey, edge);
    }
  }

  // Track relationship paths for scoring
  const relationshipPaths = new Map();

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

      // Fetch memory details
      try {
        const relatedMemory = await store.getMemory(relatedId);
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
      } catch (error) {
        // Silently skip memories that can't be fetched
        continue;
      }
    }
  }

  return expandedCandidates;
}

export async function recallPersistedMemories(store, {
  query_context,
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
  is_latest,           // boolean — undefined = default (true), false = include superseded
  include_expired,     // boolean — include expired memories
  sort,                // 'score' | 'date_asc' | 'date_desc'
  preference_boost,    // boolean — boost preference/personal/opinion memories
  include_superseded,  // boolean — include older update-chain versions via traverseUpdateChain
  access_context = null, // { projectIds, teamIds } for V2 multi-tier scope filter
  scope_filter = null,   // optional MemoryScope filter: 'personal'|'project'|'team'|'organization'
                         // limits to memories whose scope === this value (in addition to access_context)
}) {
  const temporalExpansion = expandTemporalQuery(query_context);
  const effectiveDateRange = date_range || temporalExpansion.dateRange || null;
  const temporalComparison = temporalExpansion.hasTemporalFilter || isTemporalComparisonQuery(query_context);
  const candidatePoolSize = temporalComparison
    ? Math.max(max_memories * 8, 40)
    : Math.max(max_memories * 4, 20);
  const vectorScoreThreshold = temporalComparison ? 0.15 : 0.20; // Lowered from 0.18/0.25 for better recall

  // is_latest: undefined = default true, false = include superseded versions
  const effectiveIsLatest = is_latest !== undefined ? is_latest : true;

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

  const lexicalCandidates = await store.searchMemories({
    query: query_context,
    user_id,
    org_id,
    project,
    tags,
    is_latest: effectiveIsLatest,
    n_results: candidatePoolSize,
    created_after: effectiveDateRange?.start,
    created_before: effectiveDateRange?.end,
    access_context,
  });

  const filteredLexical = lexicalCandidates.filter(memory => {
    const memTags = memory.tags || [];
    // Exclude benchmark data from production recall when no specific project is set
    if (!project && memTags.includes('longmemeval')) return false;
    if (!isMemoryInDateRange(memory, effectiveDateRange)) return false;
    if (scope_filter && memory.scope && memory.scope !== scope_filter) return false;
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

  const vectorCandidates = await vectorCandidatesForRecall(store, {
    query_context,
    user_id,
    org_id,
    project,
    source_platforms,
    tags,
    max_memories,
    dateRange: effectiveDateRange,
    scoreThreshold: vectorScoreThreshold,
    candidatePoolSize,
    is_latest: effectiveIsLatest,
    access_context,
    scope_filter,
  });
  const relationships = await store.listRelationships({ user_id, org_id, project, limit: 1000 });
  const relationshipCounts = buildRelationshipIndex(relationships);
  const contradictedIds    = buildContradictedIndex(relationships);

  // Graph Expansion: Discover related memories through graph traversal
  const expandedCandidates = await expandCandidatesViaGraph(store, {
    initialCandidates: [...filteredLexical.map(m => ({ memory: m, score: 0 })), ...vectorCandidates],
    relationships,
    relationshipCounts,
    query_context,
    weights,
    preferred_project,
    preferred_source_platforms,
    preferred_tags,
    depth: graph_expansion_depth
  });

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
    let score = (weights.similarity ?? 0.45) * similarityScore +
        (weights.recency ?? 0.15) * recencyScore +
        (weights.importance ?? 0.1) * importanceScore +
        (weights.vector ?? 0.2) * vectorScore +
        (weights.graph ?? 0.05) * graphScore +
        (weights.policy ?? 0.05) * policyScore +
        temporalBoost;
    // Superseded memory penalty
    if (memory.is_latest === false) score *= 0.55;
    // Stale-superseded penalty: superseded AND >30 days old gets extra
    // downweight. Catches old revisions that linger after drift compaction.
    if (memory.is_latest === false && daysAgo > 30) score *= 0.70;
    // Contradiction penalty: memory was flagged as target of a Contradicts
    // edge by the conflict-detector. Recall keeps it visible but should
    // rarely promote it over a non-contradicted alternative.
    if (contradictedIds.has(memory.id)) score *= 0.40;
    // Content attribution: deprioritize third-party/noise content
    const attribution = memory.metadata?.content_attribution;
    if (attribution === 'newsletter') score *= 0.5;
    else if (attribution === 'third_party') score *= 0.8;
    // Retroactive detection for untagged existing memories
    if (!attribution) {
      const c = (memory.content || '').toLowerCase();
      const t = (memory.title || '').toLowerCase();
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

    let score = (weights.similarity ?? 0.45) * (candidate.similarityScore || 0) +
        (weights.recency ?? 0.15) * recencyScore +
        (weights.importance ?? 0.1) * importanceScore +
        (weights.vector ?? 0.2) * (candidate.vectorScore || 0) +
        (weights.graph ?? 0.05) * graphScore +
        (weights.policy ?? 0.05) * policyScore +
        temporalBoost;
    // Superseded memory penalty
    if (candidate.memory?.is_latest === false) score *= 0.55;
    // Stale-superseded penalty (>30d) + contradiction penalty.
    if (candidate.memory?.is_latest === false && daysAgo > 30) score *= 0.70;
    if (candidate.memory?.id && contradictedIds.has(candidate.memory.id)) score *= 0.40;
    // Content attribution: deprioritize third-party/noise content
    const attribution = candidate.memory?.metadata?.content_attribution;
    if (attribution === 'newsletter') score *= 0.5;
    else if (attribution === 'third_party') score *= 0.8;
    // Retroactive detection for untagged existing memories
    if (!attribution && candidate.memory) {
      const c = (candidate.memory.content || '').toLowerCase();
      const t = (candidate.memory.title || '').toLowerCase();
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

  const ranked = mergeCandidateLists(scoredLexical, enrichedVector, expandedCandidates).sort((a, b) => b.score - a.score);

  // Apply memory_type boosting based on query intent (from code-review-graph's kind boosting)
  const typeBoosts = detectMemoryTypeBoost(query_context);
  if (Object.keys(typeBoosts).length > 0) {
    for (const item of ranked) {
      const memType = item.memory?.memory_type || '';
      if (typeBoosts[memType]) {
        item.score = (item.score || 0) * typeBoosts[memType];
      }
    }
    ranked.sort((a, b) => b.score - a.score);
  }

  const filtered = applyRecallRelevanceFloor(ranked, { temporalComparison });

  // Filter out meta-facts from LLM extraction that describe the extraction process, not actual user facts
  const META_FACT_RE = /\b(the user (did not|provided|shared|mentioned|gave|is discussing|discussed|started a new topic|gave a|uploaded))\b/i;
  // Also filter garbage facts that are just file references or empty content
  const GARBAGE_FACT_RE = /^(pdf"|Fact:|-- \d+ of \d+ --|\s*$)/i;
  const cleanFiltered = filtered.filter(item => {
    const content = item.content || item.memory?.content || '';
    const title = item.title || item.memory?.title || '';
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
        entityNames.push(t.replace(/^(entity|person):/, '').replace(/_/g, ' ').toLowerCase());
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
  // Phase 5 (GRAPH_MEMORY_UPGRADE): graph-structure-aware boost.
  // Hubs are the most-cited node in their cluster — preferred representative.
  // Bridges connect topics — small lift so they surface for cross-topic queries.
  // Strength reflects recall reinforcement (Phase 6) — multiplicative.
  const applyClusterBoost = (item) => {
    const mem = item.memory || item;
    const role = mem.clusterRole || mem.cluster_role;
    const hubScore = Number.isFinite(mem.hubScore) ? mem.hubScore : (Number.isFinite(mem.hub_score) ? mem.hub_score : 0);
    const strength = Number.isFinite(mem.strength) ? mem.strength : 1.0;
    let mult = 1.0;
    if (role === 'hub') mult *= 1.20;
    else if (role === 'bridge') mult *= 1.05;
    if (hubScore > 0) mult *= (1 + 0.10 * Math.min(1, hubScore));
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
    if (queryEntityTokens.length === 0) return item;
    const tags = item.memory?.tags || item.tags || [];
    if (!Array.isArray(tags) || tags.length === 0) return item;
    const entityNames = [];
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      if (t.startsWith('entity:') || t.startsWith('person:')) {
        entityNames.push(t.replace(/^(entity|person):/, '').replace(/_/g, ' ').toLowerCase());
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

    if (mult >= 3.0) mult = 3.0;
    if (!matched && mem.tier !== 1) return item;
    return {
      ...item,
      score: (item.score || 0) * mult,
      _ws_match: !!matched,
    };
  };

  const applyItemBoosts = (items) => {
    let result = items.map(item => {
      const tags = item.memory?.tags || item.tags || [];
      const isFactMemory = Array.isArray(tags) && tags.includes('extracted-fact');
      const boosted = isFactMemory ? { ...item, score: (item.score || 0) * 1.15 } : item;
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

    return result.sort((a, b) => (b.score || 0) - (a.score || 0));
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
      }
      const conf = typeof mem.synthesis_confidence === 'number'
        ? mem.synthesis_confidence
        : (typeof mem.synthesisConfidence === 'number' ? mem.synthesisConfidence : null);

      if (!srcType || conf === null) return item;
      if (srcType !== 'canonical-fact' && srcType !== 'synthesis-bridge') return item;
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

      // Source-type multiplier
      let mult = srcType === 'canonical-fact' ? 1.35 : 1.50;

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

  // Update chain traversal: include older versions when include_superseded is requested
  let finalItems = boostedItems;
  if (include_superseded) {
    const rawMemories = boostedItems.map(item => item.memory || item);
    const withSuperseded = await traverseUpdateChain(rawMemories, store);
    // Merge any newly added superseded memories back as scored items
    const existingIds = new Set(boostedItems.map(item => (item.memory || item).id));
    for (const mem of withSuperseded) {
      if (!existingIds.has(mem.id || mem.memory_id)) {
        finalItems = [...finalItems, { memory: mem, score: mem.score || 0 }];
      }
    }
  }

  let top = finalItems
    .filter(item => {
      // Exclude benchmark data from production recall
      const tags = (item.memory || item).tags || [];
      if (!project && tags.includes('longmemeval')) return false;
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
      return b.score - a.score; // default: score descending
    })
    .slice(0, max_memories);

  // ── Head-slot: guarantee top synthesis candidate is first ─────────────────
  // When mode !== 'date_asc/date_desc' and the top synthesis candidate has a
  // boosted final score > 0.6 AND confidence ≥ 0.70, splice it to slot[0].
  // This ensures panorama/quick mode always surfaces the bridge/canonical first.
  // Guard: do NOT apply when query is date-specific (date_asc/date_desc sort
  // requested, or query contains an explicit date like "2026-05-14").
  const DATE_SPECIFIC_RE = /\b\d{4}-\d{2}-\d{2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/i;
  const isDateSpecificQuery = sort === 'date_asc' || sort === 'date_desc'
    || DATE_SPECIFIC_RE.test(query_context || '');

  if (!isDateSpecificQuery && top.length > 1) {
    const synthIdx = top.findIndex(item => {
      const mem = item.memory || item;
      let srcType = mem.source_metadata?.source_type || mem.sourceMetadata?.sourceType || null;
      if (!srcType) {
        const tags = mem.tags || [];
        if (tags.includes('synthesis:canonical')) srcType = 'canonical-fact';
        else if (tags.includes('synthesis:bridge')) srcType = 'synthesis-bridge';
      }
      const conf = typeof mem.synthesis_confidence === 'number' ? mem.synthesis_confidence
        : (typeof mem.synthesisConfidence === 'number' ? mem.synthesisConfidence : null);
      return (srcType === 'canonical-fact' || srcType === 'synthesis-bridge')
        && conf !== null && conf >= 0.70
        && (item.score || 0) > 0.6;
    });
    if (synthIdx > 0) {
      const [synth] = top.splice(synthIdx, 1);
      top.unshift(synth);
    }
  }
  // Try observation prefix first (Mastra-style stable context)
  let observationPrefix = '';
  let hasObservations = false;
  try {
    const { CognitiveOperator } = await import('./operator-layer.js');
    if (store) {
      const operator = new CognitiveOperator({ store });
      const { prefix, observationCount } = await operator.assembleObservationPrefix(
        user_id, org_id, { project, maxTokens: 4000 }
      );
      if (observationCount >= 3) {
        observationPrefix = prefix;
        hasObservations = true;
      }
    }
  } catch {
    // Observation prefix not available — fall through to standard retrieval
  }

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

  // Inject user profile (static facts, ~50ms)
  try {
    const { UserProfile } = await import('./user-profile.js');
    const userProfileManager = new UserProfile(store);
    const { profile: userProfileText } = await userProfileManager.getProfile(user_id, org_id);
    if (userProfileText) {
      injectionText = userProfileText + '\n\n' + injectionText;
    }
  } catch {
    // User profile not available
  }

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
  }));

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

  // Build evidence snippets for synthesized items from synthesisEvidenceIds
  const buildEvidenceSnippets = async (synthMem) => {
    const evidenceIds = synthMem.synthesis_evidence_ids || synthMem.synthesisEvidenceIds || [];
    if (!evidenceIds.length) return [];
    try {
      const evidenceMems = await Promise.all(
        evidenceIds.slice(0, 5).map(id => store.getMemory(id).catch(() => null))
      );
      return evidenceMems.filter(Boolean).map(e => ({
        id:      e.id,
        title:   e.title || null,
        snippet: (e.content || '').slice(0, 200),
      }));
    } catch {
      return [];
    }
  };

  // Enrich synthesized items with evidence snippets (async but bounded)
  const synthesized = await Promise.all(synthesizedItems.map(async m => {
    const srcType  = getSynthesisSourceType(m);
    const conf     = typeof m.synthesis_confidence === 'number' ? m.synthesis_confidence
      : (typeof m.synthesisConfidence === 'number' ? m.synthesisConfidence : null);
    const revision = m.synthesis_revision || m.synthesisRevision || 1;
    const evidence = await buildEvidenceSnippets(m);
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

  return Array.from(out);
}

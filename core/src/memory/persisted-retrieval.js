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
  const haystack = [
    memory.content || '',
    memory.project || '',
    memory.source || '',
    ...(memory.tags || []),
    ...scopeChain(ast),
    ast.signature || '',
    ...(ast.imports || [])
  ].join(' ').toLowerCase();

  const direct = haystack.includes(lowered) ? 2 : 0;
  const tokenHits = tokens.filter(token => haystack.includes(token)).length;
  return direct + tokenHits;
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
  const topScore = scored[0].score;
  const topSimilarity = scored[0].similarityScore ?? 0;
  const minimumScore = temporalComparison
    ? Math.max(topScore * 0.20, 0.08)
    : Math.max(topScore * 0.30, 0.12);
  const minimumSimilarity = temporalComparison
    ? Math.max(topSimilarity * 0.25, 0.14)
    : Math.max(topSimilarity * 0.40, 0.22);
  const filtered = scored.filter(item =>
    item.score >= minimumScore &&
    (item.similarityScore ?? 0) >= minimumSimilarity
  );
  return filtered.length > 0 ? filtered : scored.slice(0, temporalComparison ? 5 : 1);
}

function mergeCandidateLists(...lists) {
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
    // Exclude benchmark data from production recall when no specific project is set
    if (!project && (item.memory?.tags || []).includes('longmemeval')) return false;
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

        // Calculate final score with slight penalty for being expanded (not direct match)
        const expansionPenalty = 0.15; // Slight penalty for indirect matches
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
}) {
  const temporalExpansion = expandTemporalQuery(query_context);
  const effectiveDateRange = date_range || temporalExpansion.dateRange || null;
  const temporalComparison = temporalExpansion.hasTemporalFilter || isTemporalComparisonQuery(query_context);
  const candidatePoolSize = temporalComparison
    ? Math.max(max_memories * 8, 40)
    : Math.max(max_memories * 4, 20);
  const vectorScoreThreshold = temporalComparison ? 0.18 : 0.25;

  // is_latest: undefined = default true, false = include superseded versions
  const effectiveIsLatest = is_latest !== undefined ? is_latest : true;

  const lexicalCandidates = await store.searchMemories({
    query: query_context,
    user_id,
    org_id,
    project,
    tags,
    is_latest: effectiveIsLatest,
    n_results: candidatePoolSize,
    created_after: effectiveDateRange?.start,
    created_before: effectiveDateRange?.end
  });

  const filteredLexical = lexicalCandidates.filter(memory => {
    // Exclude benchmark data from production recall when no specific project is set
    if (!project && (memory.tags || []).includes('longmemeval')) return false;
    if (!isMemoryInDateRange(memory, effectiveDateRange)) return false;
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
  });
  const relationships = await store.listRelationships({ user_id, org_id, project, limit: 1000 });
  const relationshipCounts = buildRelationshipIndex(relationships);

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

    const similarityScore = computeTokenSimilarity(query_context || '', memory.content || '');
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
  const filtered = applyRecallRelevanceFloor(ranked, { temporalComparison });
  const deduped = collapseNearDuplicates(filtered, { preserveTemporalDistinctness: temporalComparison });

  // Apply fact-memory boost before slicing to contextLimit
  // Items have shape { memory, score, vectorScore, ... }
  const applyItemBoosts = (items) => {
    let result = items.map(item => {
      const tags = item.memory?.tags || item.tags || [];
      const isFactMemory = Array.isArray(tags) && tags.includes('extracted-fact');
      if (isFactMemory) return { ...item, score: (item.score || 0) * 1.15 };
      return item;
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

  const boostedItems = applyItemBoosts(deduped);

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

  const top = finalItems
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

  return {
    memories: top.map(item => ({
      ...item.memory,
      score: item.score,
      vector_score: item.vectorScore || 0,
      keyword_score: item.keywordScore || 0,
      graph_score: item.graphScore || 0,
      policy_score: item.policyScore || 0,
      graph_expanded: item.graph_expanded || false,
      expansion_metadata: item.expansion_metadata || null
    })),
    injectionText,
    search_method: vectorCandidates.length > 0 ? 'persisted-hybrid' : 'persisted-keyword',
    expansion_stats: {
      expanded_count: expandedCandidates.length,
      included_count: top.filter(item => item.graph_expanded).length
    }
  };
}

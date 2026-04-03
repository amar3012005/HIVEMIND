/**
 * Query Rewriter — expands and reformulates queries for better retrieval coverage.
 *
 * Strategy: Deterministic rewriting (no LLM call) for speed.
 * - Entity extraction (proper nouns, quoted terms)
 * - Synonym expansion for common query patterns
 * - Stripped query (remove filler words for tighter vector match)
 */

// Common filler words to strip for focused vector search
const FILLER_WORDS = new Set([
  'please', 'can', 'you', 'tell', 'me', 'about', 'what', 'is', 'the',
  'do', 'does', 'did', 'how', 'when', 'where', 'who', 'which', 'a', 'an',
  'i', 'my', 'we', 'our', 'have', 'has', 'had', 'was', 'were', 'been',
  'being', 'that', 'this', 'those', 'these', 'there', 'here', 'some', 'any',
  'know', 'remember', 'recall', 'think', 'said', 'mentioned', 'told',
  'just', 'also', 'really', 'very', 'much', 'quite', 'still', 'already',
]);

// Expansion synonyms for common retrieval terms
const EXPANSION_MAP = {
  'meeting': ['call', 'discussion', 'session', 'standup', 'sync'],
  'email': ['message', 'mail', 'correspondence'],
  'project': ['initiative', 'work', 'task', 'effort'],
  'problem': ['issue', 'bug', 'error', 'trouble'],
  'fix': ['resolve', 'repair', 'patch', 'solution'],
  'deadline': ['due date', 'timeline', 'schedule'],
  'team': ['group', 'squad', 'colleagues'],
  'manager': ['lead', 'supervisor', 'boss'],
  'salary': ['pay', 'compensation', 'wage', 'income'],
  'vacation': ['holiday', 'time off', 'leave', 'pto'],
  'document': ['file', 'doc', 'report', 'paper'],
  'presentation': ['deck', 'slides', 'ppt'],
  'code': ['source', 'implementation', 'codebase', 'program'],
  'deploy': ['release', 'ship', 'publish', 'push'],
  'buy': ['purchase', 'order', 'acquire'],
  'cost': ['price', 'expense', 'fee', 'charge'],
};

/**
 * Extract entities from query: quoted strings, capitalized phrases, and proper nouns.
 */
function extractEntities(query) {
  const entities = [];

  // Quoted terms
  const quoted = query.match(/"([^"]+)"/g) || [];
  for (const q of quoted) entities.push(q.replace(/"/g, ''));

  // Capitalized multi-word phrases (likely proper nouns)
  const caps = query.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g) || [];
  for (const c of caps) entities.push(c);

  // Single capitalized words that aren't sentence starters
  const words = query.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/[^a-zA-Z]/g, '');
    if (w.length > 2 && /^[A-Z][a-z]/.test(w) && !FILLER_WORDS.has(w.toLowerCase())) {
      entities.push(w);
    }
  }

  // Deduplicate, removing single words that are part of a multi-word entity
  const unique = [...new Set(entities)];
  return unique.filter(e => {
    if (!e.includes(' ')) {
      return !unique.some(other => other.includes(' ') && other.includes(e));
    }
    return true;
  });
}

/**
 * Create a stripped version of the query (filler removed) for tighter vector matching.
 */
function stripFiller(query) {
  const words = query.toLowerCase().split(/\s+/).filter(w => {
    const clean = w.replace(/[^a-z']/g, '');
    return clean.length > 1 && !FILLER_WORDS.has(clean);
  });
  return words.join(' ');
}

/**
 * Expand query with synonym terms for broader coverage.
 */
function expandWithSynonyms(query) {
  const lower = query.toLowerCase();
  const expansions = [];
  for (const [term, synonyms] of Object.entries(EXPANSION_MAP)) {
    if (lower.includes(term)) {
      // Add top 2 synonyms
      expansions.push(...synonyms.slice(0, 2));
    }
  }
  return expansions;
}

/**
 * Main rewrite function.
 * Returns: { original, stripped, expanded, entities, searchQueries }
 *
 * searchQueries is an array of query strings to search with.
 * The caller should search with all queries and merge/dedup results.
 */
export function rewriteQuery(query) {
  if (!query || typeof query !== 'string') {
    return { original: query || '', stripped: '', expanded: '', entities: [], searchQueries: [query || ''] };
  }

  const original = query.trim();
  const entities = extractEntities(original);
  const stripped = stripFiller(original);
  const synonyms = expandWithSynonyms(original);

  // Build expanded query: original keywords + synonyms
  const expanded = synonyms.length > 0
    ? `${stripped} ${synonyms.join(' ')}`
    : stripped;

  // Build search query set (deduplicated)
  const searchQueries = [original]; // Always include original
  if (stripped && stripped !== original.toLowerCase()) {
    searchQueries.push(stripped);
  }
  // If we have entities, add an entity-focused query
  if (entities.length > 0) {
    const entityQuery = entities.join(' ');
    if (!searchQueries.includes(entityQuery)) {
      searchQueries.push(entityQuery);
    }
  }

  return { original, stripped, expanded, entities, searchQueries };
}

/**
 * Multi-query search wrapper.
 * Runs multiple query variants through a search function and merges results.
 * Deduplicates by memory ID, keeping highest score.
 */
export async function multiQuerySearch(searchFn, query, options = {}) {
  const { searchQueries } = rewriteQuery(query);

  // Limit to max 2 queries for performance (original + best expansion)
  const queriesToRun = searchQueries.slice(0, 2);

  const allResults = [];
  for (const q of queriesToRun) {
    const results = await searchFn(q, options);
    if (Array.isArray(results)) {
      allResults.push(...results);
    } else if (results?.results) {
      allResults.push(...results.results);
    }
  }

  // Dedup by ID, keep highest score
  const seen = new Map();
  for (const r of allResults) {
    const id = r.id || r.memory_id || JSON.stringify(r).slice(0, 50);
    const existing = seen.get(id);
    if (!existing || (r.score || 0) > (existing.score || 0)) {
      seen.set(id, r);
    }
  }

  return [...seen.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
}

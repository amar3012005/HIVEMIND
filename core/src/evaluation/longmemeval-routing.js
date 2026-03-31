import { expandTemporalQuery } from '../search/time-aware-expander.js';

function normalizeText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[`*_>#-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractItems(searchResults) {
  if (!searchResults) return [];
  if (Array.isArray(searchResults)) return searchResults;
  if (Array.isArray(searchResults.results)) return searchResults.results;
  if (Array.isArray(searchResults.memories)) return searchResults.memories;
  if (Array.isArray(searchResults.categories)) return searchResults.categories;
  return [];
}

function getMemoryContent(item = {}) {
  return item.content
    || item.payload?.content
    || item.memory?.content
    || item.summary
    || '';
}

function getMemoryTitle(item = {}) {
  return item.title
    || item.payload?.title
    || item.memory?.title
    || item.name
    || '';
}

function getMemoryDate(item = {}) {
  return item.document_date
    || item.payload?.document_date
    || item.memory?.document_date
    || item.created_at
    || item.payload?.created_at
    || item.memory?.created_at
    || '';
}

function getMemoryType(item = {}) {
  return item.memory_type
    || item.payload?.memory_type
    || item.memory?.memory_type
    || item.type
    || '';
}

function getMemoryTags(item = {}) {
  const tags = item.tags || item.payload?.tags || item.memory?.tags || [];
  return Array.isArray(tags) ? tags : [];
}

function getMemoryScore(item = {}) {
  return Number(item.score ?? item.relevance ?? item.similarity ?? 0);
}

function uniqueByContent(items) {
  const seen = new Set();
  const deduped = [];

  for (const item of items) {
    const content = normalizeText(getMemoryContent(item));
    const title = normalizeText(getMemoryTitle(item));
    const key = content || title || JSON.stringify(getMemoryTags(item));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function sortSearchItems(items) {
  return [...items].sort((left, right) => {
    const scoreDiff = getMemoryScore(right) - getMemoryScore(left);
    if (scoreDiff !== 0) return scoreDiff;

    const rightDate = new Date(getMemoryDate(right) || 0).getTime();
    const leftDate = new Date(getMemoryDate(left) || 0).getTime();
    if (rightDate !== leftDate) return rightDate - leftDate;

    return getMemoryTitle(right).localeCompare(getMemoryTitle(left));
  });
}

function sortSearchItemsChronologically(items, direction = 'asc') {
  const factor = direction === 'desc' ? -1 : 1;
  return [...items].sort((left, right) => {
    const leftDate = new Date(getMemoryDate(left) || 0).getTime();
    const rightDate = new Date(getMemoryDate(right) || 0).getTime();
    if (leftDate !== rightDate) return (leftDate - rightDate) * factor;

    const scoreDiff = getMemoryScore(right) - getMemoryScore(left);
    if (scoreDiff !== 0) return scoreDiff;

    return getMemoryTitle(left).localeCompare(getMemoryTitle(right));
  });
}

function buildContextSnippet(item = {}) {
  const title = getMemoryTitle(item);
  const tags = getMemoryTags(item);
  const memoryType = getMemoryType(item);
  const score = getMemoryScore(item);
  const date = getMemoryDate(item);
  const content = getMemoryContent(item).trim();
  const headerParts = [];

  if (Number.isFinite(score) && score > 0) {
    headerParts.push(`score=${score.toFixed(3)}`);
  }
  if (date) headerParts.push(`date=${date}`);
  if (memoryType) headerParts.push(`type=${memoryType}`);
  if (tags.length > 0) headerParts.push(`tags=${tags.slice(0, 6).join(',')}`);
  if (title) headerParts.push(`title=${title}`);

  const header = headerParts.length > 0 ? `(${headerParts.join(' | ')}) ` : '';
  return `${header}${content}`;
}

export function buildBenchmarkContext(searchResults, { maxItems = 25, maxChars = 16000, sortMode = 'score' } = {}) {
  const deduped = uniqueByContent(extractItems(searchResults));
  const items = sortMode === 'date_asc'
    ? sortSearchItemsChronologically(deduped, 'asc')
    : sortMode === 'date_desc'
      ? sortSearchItemsChronologically(deduped, 'desc')
      : sortSearchItems(deduped);
  const lines = [];
  let totalChars = 0;

  for (const item of items.slice(0, maxItems)) {
    const snippet = buildContextSnippet(item);
    if (!snippet) continue;

    const line = `- ${snippet}`;
    if (totalChars + line.length > maxChars) break;
    lines.push(line);
    totalChars += line.length;
  }

  return lines.join('\n---\n');
}

export function getLongMemEvalRetrievalPlan({ question, questionType } = {}) {
  const temporalExpansion = expandTemporalQuery(question || '');

  // Type-specific retrieval routing — each question type gets the optimal search strategy
  switch (questionType) {
    case 'temporal-reasoning':
      return {
        route: 'recall',
        body: {
          query_context: question,
          date_range: temporalExpansion.dateRange || null,
          max_memories: 20,
          sort: 'date_asc',  // chronological ordering helps temporal reasoning
        },
        searchLimit: 20,
        contextLimit: 18,
        contextSortMode: 'date_asc',
        maxChars: 14000,
        systemHint: 'Calculate dates precisely. Show your arithmetic. Use the exact dates from the context. If asked "how many days/weeks/months", count from the specific dates mentioned.',
      };

    case 'knowledge-update':
      return {
        route: 'recall',  // recall with is_latest + merge panorama for version history
        body: {
          query_context: question,
          max_memories: 20,
          is_latest: true,  // only latest versions of facts
          sort: 'date_asc',  // chronological update chain
          include_superseded: true,  // show version history
        },
        mergeWithPanorama: true,  // also fetch panorama for version chain
        searchLimit: 20,
        contextLimit: 20,
        contextSortMode: 'date_asc',
        maxChars: 14000,
        enablePredictCalibrate: true,  // enable Updates relationship + is_latest marking
        systemHint: 'IMPORTANT: Show the EVOLUTION of this information. The user is asking about an update or change. Present the history chronologically — what was the old value, what is the new value. Give the MOST RECENT answer but acknowledge the update chain.',
      };

    case 'multi-session':
      return {
        route: 'recall',
        body: {
          query_context: question,
          max_memories: 40,  // need more — facts scattered across sessions
          inject_parent_chunks: true,
        },
        searchLimit: 40,
        contextLimit: 30,
        contextSortMode: 'date_asc',
        maxChars: 16000,
        systemHint: 'IMPORTANT: Synthesize ALL information across ALL sessions. This question spans multiple separate conversation sessions. Count EACH item from EVERY session. Present all instances chronologically. Do NOT stop after finding one answer.',
      };

    case 'single-session-user':
      return {
        route: 'quick',
        body: {
          query: question,
          limit: 25,
        },
        searchLimit: 25,
        contextLimit: 20,
        contextSortMode: 'score',
        maxChars: 14000,
        systemHint: 'Answer with the SPECIFIC detail the user mentioned. The user is asking about something they themselves said or did. Find the exact statement or fact from the memories. Be precise and literal — use the exact words from the context.',
      };

    case 'single-session-assistant':
      return {
        route: 'quick',
        body: {
          query: question,
          limit: 20,
        },
        searchLimit: 20,
        contextLimit: 15,
        contextSortMode: 'score',
        systemHint: 'Recall the exact information the assistant previously provided to the user. Be precise.',
      };

    case 'single-session-preference':
      return {
        route: 'recall',  // Operator Layer for preference intent detection
        body: {
          query_context: question,
          max_memories: 25,
          memory_types: ['observation', 'fact', 'preference'],
          preference_boost: true,
        },
        searchLimit: 25,
        contextLimit: 20,
        contextSortMode: 'score',
        maxChars: 14000,
        systemHint: 'IMPORTANT: This question asks about personal preferences, opinions, tastes, or choices. Look carefully through the memories for: what the user said they like/prefer/enjoy, their stated opinions, their explicit choices. The answer is always something the user PERSONALLY expressed. Be specific about what they said they preferred.',
      };

    default:
      return {
        route: 'recall',
        body: {
          query_context: question,
          max_memories: 20,
        },
        searchLimit: 20,
        contextLimit: 15,
        contextSortMode: 'score',
        systemHint: 'Answer from the retrieved memory context only. If memories conflict, prefer the most recent valid memory.',
      };
  }
}

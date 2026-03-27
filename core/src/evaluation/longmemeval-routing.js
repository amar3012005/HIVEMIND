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

export function buildBenchmarkContext(searchResults, { maxItems = 6, maxChars = 7000 } = {}) {
  const items = sortSearchItems(uniqueByContent(extractItems(searchResults)));
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
  const isTemporal = questionType === 'temporal-reasoning' || temporalExpansion.hasTemporalFilter;
  const isKnowledgeUpdate = questionType === 'knowledge-update';

  if (isTemporal) {
    return {
      route: 'panorama',
      body: {
        query: question,
        include_expired: true,
        include_historical: true,
        date_range: temporalExpansion.dateRange || null,
        limit: 15,
        include_timeline: false
      },
      searchLimit: 15,
      contextLimit: 8,
      systemHint: temporalExpansion.temporalHint
        ? `Temporal focus: ${temporalExpansion.temporalHint}. Prefer memories inside the requested time window and resolve conflicts using the most recent valid memory.`
        : 'Temporal focus: prefer memories inside the requested time window and resolve conflicts using the most recent valid memory.'
    };
  }

  if (isKnowledgeUpdate) {
    return {
      route: 'panorama',
      body: {
        query: question,
        include_expired: true,
        include_historical: true,
        limit: 15,
        include_timeline: true
      },
      searchLimit: 15,
      contextLimit: 8,
      systemHint: 'Knowledge-update focus: prefer the updated answer, but keep prior context available when it explains the change.'
    };
  }

  return {
    route: 'recall',
    body: {
      query_context: question,
      max_memories: 8
    },
    searchLimit: 8,
    contextLimit: 6,
    systemHint: 'Answer from the retrieved memory context only. If memories conflict, prefer the most recent valid memory.'
  };
}


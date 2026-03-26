/**
 * fact-extractor.js
 *
 * Extracts keyphrases, named entities, and temporal references from memory
 * content to build "fact-augmented keys" for improved Qdrant retrieval (~5% gain).
 */

/** Stopwords to exclude from keyphrase extraction. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'were', 'they',
  'their', 'what', 'when', 'where', 'who', 'will', 'with', 'this', 'that',
  'from', 'about', 'into', 'more', 'some', 'than', 'them', 'then', 'would',
  'could', 'should', 'also', 'just', 'like', 'only', 'each', 'make', 'does',
  // extras for cleaner results
  'a', 'an', 'is', 'be', 'to', 'of', 'in', 'on', 'at', 'by', 'as', 'it',
  'its', 'we', 'he', 'she', 'me', 'my', 'his', 'him', 'or', 'if', 'so',
  'up', 'do', 'no', 'how', 'why', 'any', 'use', 'used', 'may', 'which',
  'new', 'now', 'here', 'there', 'such', 'own', 'very', 'too', 'these',
  'those', 'both', 'few', 'other', 'over', 'again', 'further', 'once',
  'after', 'before', 'between', 'through', 'during',
]);

/** Month names for temporal regex. */
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

/** Temporal regex patterns (ordered, applied in sequence). */
const TEMPORAL_PATTERNS = [
  // ISO date: 2026-03-15
  /\b(\d{4}-\d{2}-\d{2})\b/g,
  // "March 15th, 2026" / "March 15 2026" / "15 March 2026"
  new RegExp(`\\b(?:(${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+(${MONTHS})(?:,?\\s+\\d{4})?)\\b`, 'g'),
  // Quarter: Q1 2026, Q4 2025
  /\b(Q[1-4]\s+\d{4})\b/g,
  // Relative: last week, yesterday, last Tuesday, next Monday, this month
  /\b(last\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|yesterday|today|tomorrow|next\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this\s+(?:week|month|year))\b/gi,
  // Year-only references that look intentional: "in 2026", "by 2025"
  /\b(?:in|by|since|until|before|after)\s+(\d{4})\b/g,
];

/**
 * Tokenize content into lowercase words, filtering stopwords and short tokens.
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Heuristic keyphrase extraction: frequency-ranked top-10 tokens.
 */
function extractKeyphrasesHeuristic(content) {
  const tokens = tokenize(content);
  if (tokens.length === 0) return [];

  const freq = new Map();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

/**
 * Heuristic entity extraction: multi-word capitalized names and acronyms.
 */
function extractEntitiesHeuristic(content) {
  const seen = new Set();
  const results = [];

  // Multi-word capitalized names: "Sarah Johnson", "Engineering Team"
  const multiWordRe = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  let m;
  while ((m = multiWordRe.exec(content)) !== null && results.length < 15) {
    const val = m[1];
    if (!seen.has(val)) {
      seen.add(val);
      results.push(val);
    }
  }

  // Acronyms: API, NASA, HTTP, REST (3+ chars, all caps, optionally with digits/underscores)
  const acronymRe = /\b([A-Z][A-Z0-9_]{2,})\b/g;
  while ((m = acronymRe.exec(content)) !== null && results.length < 15) {
    const val = m[1];
    if (!seen.has(val)) {
      seen.add(val);
      results.push(val);
    }
  }

  // Single capitalized words that are likely proper nouns (not at sentence start after period)
  // Capture names like "Sarah" or "Jake" even when alone
  const singleNameRe = /(?:^|[.!?]\s+|\s)([A-Z][a-z]{2,})(?=\s)/g;
  while ((m = singleNameRe.exec(content)) !== null && results.length < 15) {
    const val = m[1];
    // Skip common English words that happen to be capitalized
    const skipWords = new Set([
      'The', 'This', 'That', 'These', 'Those', 'There', 'Their', 'They',
      'When', 'Where', 'What', 'Which', 'While', 'With', 'From', 'Into',
      'Some', 'Such', 'Each', 'Both', 'More', 'Most', 'Also', 'Just',
      'Last', 'Next', 'Then', 'Than', 'Very', 'Only', 'After', 'Before',
      'During', 'Over', 'Under', 'About', 'Through', 'Between', 'Here',
    ]);
    if (!seen.has(val) && !skipWords.has(val)) {
      seen.add(val);
      results.push(val);
    }
  }

  return results.slice(0, 15);
}

/**
 * Heuristic temporal reference extraction.
 */
function extractTemporalRefsHeuristic(content) {
  const seen = new Set();
  const results = [];

  for (const pattern of TEMPORAL_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    let m;
    const re = new RegExp(pattern.source, pattern.flags);
    while ((m = re.exec(content)) !== null && results.length < 10) {
      const val = m[0].trim();
      if (val && !seen.has(val.toLowerCase())) {
        seen.add(val.toLowerCase());
        results.push(val);
      }
    }
    if (results.length >= 10) break;
  }

  return results;
}

/**
 * Calls Groq Llama 3 to extract structured facts via LLM.
 * Returns merged results with heuristic fallback on error.
 */
async function extractWithLLM(content, groqClient, heuristic) {
  try {
    const prompt = `Extract facts from the following text. Return a JSON object with these fields:
- keyphrases: array of up to 10 important topic words or short phrases
- entities: array of up to 15 named entities (people, organizations, systems, acronyms)
- temporalRefs: array of up to 10 date/time references

Text:
"""
${content}
"""

Respond with only valid JSON, no explanation.`;

    const response = await groqClient.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 512,
    });

    const raw = response.choices?.[0]?.message?.content?.trim() || '{}';
    // Strip markdown code fences if present
    const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(json);

    // Merge LLM results with heuristic, deduplicating
    const merge = (llmArr, hArr) => {
      const seen = new Set((llmArr || []).map(s => s.toLowerCase()));
      const merged = [...(llmArr || [])];
      for (const item of hArr) {
        if (!seen.has(item.toLowerCase())) {
          seen.add(item.toLowerCase());
          merged.push(item);
        }
      }
      return merged;
    };

    return {
      keyphrases: merge(parsed.keyphrases, heuristic.keyphrases).slice(0, 10),
      entities: merge(parsed.entities, heuristic.entities).slice(0, 15),
      temporalRefs: merge(parsed.temporalRefs, heuristic.temporalRefs).slice(0, 10),
      summary: parsed.summary || heuristic.summary,
    };
  } catch {
    // Fallback to heuristic on any LLM error
    return heuristic;
  }
}

/**
 * Extracts keyphrases, entities, and temporal references from content.
 *
 * @param {string} content - The memory content to analyze.
 * @param {object} options
 * @param {boolean} [options.useLLM=false] - Whether to call Groq LLM for extraction.
 * @param {object} [options.groqClient] - Groq client instance (required if useLLM=true).
 * @returns {Promise<{keyphrases: string[], entities: string[], temporalRefs: string[], summary: string}>}
 */
export async function extractFacts(content, options = {}) {
  if (!content || content.length < 10) {
    return { keyphrases: [], entities: [], temporalRefs: [], summary: '' };
  }

  const heuristic = {
    keyphrases: extractKeyphrasesHeuristic(content),
    entities: extractEntitiesHeuristic(content),
    temporalRefs: extractTemporalRefsHeuristic(content),
    summary: '',
  };

  if (options.useLLM && options.groqClient) {
    return extractWithLLM(content, options.groqClient, heuristic);
  }

  return heuristic;
}

/**
 * Builds a fact-augmented key by appending extracted facts to the raw content.
 * Only appends sections that have data.
 *
 * @param {string} content - The original memory content.
 * @param {object} facts - Facts object from extractFacts.
 * @returns {string} Augmented string for embedding.
 */
export function buildAugmentedKey(content, facts) {
  let result = content;

  if (facts.keyphrases && facts.keyphrases.length > 0) {
    result += `\nKey topics: ${facts.keyphrases.join(', ')}`;
  }

  if (facts.entities && facts.entities.length > 0) {
    result += `\nEntities: ${facts.entities.join(', ')}`;
  }

  if (facts.temporalRefs && facts.temporalRefs.length > 0) {
    result += `\nDates: ${facts.temporalRefs.join(', ')}`;
  }

  return result;
}

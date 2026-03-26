/**
 * observer.js
 *
 * Observer agent for the Observer-Reflector pipeline.
 * Converts raw conversation turns into dense, dated observation nodes
 * with 3-6x compression using heuristic extraction (default) or LLM.
 */

import { formatObservation } from './observation-store.js';

/** Month names for temporal regex. */
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

/** Patterns that indicate HIGH-priority user facts. */
const HIGH_PRIORITY_PATTERNS = [
  /\bI graduated\b/i,
  /\bmy commute\b/i,
  /\bI bought\b/i,
  /\bmy dog\b/i,
  /\bI prefer\b/i,
  /\bmy job\b/i,
  /\bI work(ed)?\b/i,
  /\bI started\b/i,
  /\bI live(d)?\b/i,
  /\bmy home\b/i,
  /\bmy wife\b/i,
  /\bmy husband\b/i,
  /\bmy kid\b/i,
  /\bmy child\b/i,
  /\bI am\b/i,
  /\bI'm\b/i,
  /\bmy name\b/i,
];

/** Patterns that indicate LOW-priority content (jokes, generic help requests). */
const LOW_PRIORITY_PATTERNS = [
  /\btell me a joke\b/i,
  /\bcan you.*joke\b/i,
  /\bhelp me with\b/i,
  /\bhow do (I|you)\b/i,
  /\bwhat is\b/i,
  /\bwhat are\b/i,
  /\bcan you (help|explain|describe|list|show)\b/i,
  /\btell me (about|how)\b/i,
];

/** Patterns for trivial/social exchanges that yield no memory value. */
const TRIVIAL_PATTERNS = [
  /^(thanks?|thank you|thx|ty)[\s!.]*$/i,
  /^you'?re welcome[\s!.]*$/i,
  /^(ok|okay|got it|sure|alright|sounds good)[\s!.]*$/i,
  /^(hi|hello|hey|good morning|good evening|good afternoon)[\s!.]*$/i,
  /^(bye|goodbye|see you|take care|cya)[\s!.]*$/i,
];

/** Temporal reference patterns (ordered by specificity). */
const TEMPORAL_PATTERNS = [
  // ISO date: 2021-06-15
  /\b(\d{4}-\d{2}-\d{2})\b/,
  // "June 15, 2021" / "June 15 2021"
  new RegExp(`\\b((?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?)\\b`),
  // "15 June 2021"
  new RegExp(`\\b(\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})(?:,?\\s+\\d{4})?)\\b`),
  // "in 2012", "since 2015"
  /\b(?:in|since|by|until|before|after)\s+(\d{4})\b/,
];

/**
 * Extract lines spoken by the user from a conversation turn.
 * Handles both "User: ..." prefixed lines and bare content.
 *
 * @param {string} content
 * @returns {string}
 */
function extractUserContent(content) {
  const lines = content.split('\n');
  const userLines = lines.filter((l) => /^User:\s*/i.test(l));

  if (userLines.length > 0) {
    return userLines.map((l) => l.replace(/^User:\s*/i, '').trim()).join(' ');
  }

  // Fallback: return all non-assistant lines
  const nonAssistantLines = lines.filter((l) => !/^Assistant:\s*/i.test(l));
  return nonAssistantLines.join(' ').trim();
}

/**
 * Check if content is trivial (greetings, thanks, social niceties).
 *
 * @param {string} userContent - Extracted user content
 * @returns {boolean}
 */
function isTrivial(userContent) {
  const trimmed = userContent.trim();
  // Check each sentence/phrase individually
  const phrases = trimmed.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  return phrases.every((phrase) => TRIVIAL_PATTERNS.some((p) => p.test(phrase)));
}

/**
 * Classify priority of the user content.
 *
 * @param {string} userContent
 * @returns {'HIGH'|'MEDIUM'|'LOW'}
 */
function classifyPriority(userContent) {
  if (HIGH_PRIORITY_PATTERNS.some((p) => p.test(userContent))) {
    return 'HIGH';
  }
  if (LOW_PRIORITY_PATTERNS.some((p) => p.test(userContent))) {
    return 'LOW';
  }
  return 'MEDIUM';
}

/**
 * Extract the first temporal reference from content.
 *
 * @param {string} content
 * @returns {string|null}
 */
function extractReferencedDate(content) {
  for (const pattern of TEMPORAL_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      // Return capture group 1 if present, otherwise full match
      return (match[1] ?? match[0]).trim();
    }
  }
  return null;
}

/**
 * Compress user content to a dense observation.
 * Extracts sentences containing first-person pronouns (I/my/me),
 * then joins and caps at 200 characters.
 *
 * @param {string} userContent
 * @returns {string}
 */
function compress(userContent) {
  // Split into sentences
  const sentences = userContent.split(/(?<=[.!?])\s+/);

  // Prefer sentences with first-person pronouns
  const firstPersonSentences = sentences.filter((s) => /\b(I|my|me|I'm|I've|I'd|I'll)\b/i.test(s));

  const selected = firstPersonSentences.length > 0 ? firstPersonSentences : sentences;
  let result = selected.join(' ').trim();

  // Cap at 200 characters, breaking at a word boundary
  if (result.length > 200) {
    result = result.slice(0, 200).replace(/\s+\S*$/, '').trim();
  }

  return result;
}

export class Observer {
  /**
   * @param {object} [options]
   * @param {object} [options.groqClient] - Optional Groq client for LLM mode
   * @param {boolean} [options.useLLM=false] - Use LLM instead of heuristics
   */
  constructor(options = {}) {
    this.groqClient = options.groqClient ?? null;
    this.useLLM = options.useLLM ?? false;
  }

  /**
   * Process a raw conversation turn into a dense observation node.
   *
   * @param {object} params
   * @param {string} params.content - Raw conversation content
   * @param {string} [params.documentDate] - ISO date for when document was ingested
   * @param {string[]} [params.tags] - Optional topic tags
   * @returns {Promise<{observation: string|null, priority: string, referencedDate: string|null, compressed: boolean}>}
   */
  async observe({ content, documentDate, tags }) {
    if (!content || !content.trim()) {
      return { observation: null, priority: 'LOW', referencedDate: null, compressed: false };
    }

    const userContent = extractUserContent(content);

    // Skip trivial exchanges
    if (isTrivial(userContent)) {
      return { observation: null, priority: 'LOW', referencedDate: null, compressed: false };
    }

    const priority = classifyPriority(userContent);
    const referencedDate = extractReferencedDate(content);

    let observationText;
    let compressed = false;

    if (this.useLLM && this.groqClient) {
      observationText = await this._observeWithLLM(content);
      compressed = observationText.length < content.length;
    } else {
      const compressedText = compress(userContent);
      compressed = compressedText.length < content.length;
      observationText = compressedText;
    }

    const observation = formatObservation({
      content: observationText,
      priority: priority.toLowerCase(),
      observationDate: documentDate ?? new Date().toISOString().slice(0, 10),
      referencedDate: referencedDate ?? undefined,
    });

    return {
      observation,
      priority,
      referencedDate,
      compressed,
    };
  }

  /**
   * LLM-based observation (Groq).
   * @private
   */
  async _observeWithLLM(content) {
    const response = await this.groqClient.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [
        {
          role: 'system',
          content:
            'You are a memory compression agent. Extract only the key user facts from this conversation turn. ' +
            'Output a single dense sentence of at most 200 characters. Focus on: personal facts, preferences, events. ' +
            'If there are no memorable facts, output: TRIVIAL',
        },
        { role: 'user', content },
      ],
      max_tokens: 80,
      temperature: 0,
    });
    const text = response.choices[0]?.message?.content?.trim() ?? '';
    return text === 'TRIVIAL' ? null : text;
  }
}

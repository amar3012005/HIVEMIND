/**
 * observation-store.js
 * Utilities for formatting, parsing, merging, and building observation nodes
 * in the Observer-Reflector pipeline.
 */

const PRIORITY_EMOJI = {
  high: '🔴',
  medium: '🟡',
  low: '🟢',
};

const EMOJI_PRIORITY = Object.fromEntries(
  Object.entries(PRIORITY_EMOJI).map(([k, v]) => [v, k])
);

/**
 * Format an observation into a compact string line.
 * @param {object} opts
 * @param {string} opts.content
 * @param {'high'|'medium'|'low'} opts.priority
 * @param {string} opts.observationDate - ISO date string or YYYY-MM-DD
 * @param {string} [opts.referencedDate] - ISO date string or YYYY-MM-DD
 * @param {string} [opts.source]
 * @returns {string}
 */
export function formatObservation({ content, priority, observationDate, referencedDate, source }) {
  const emoji = PRIORITY_EMOJI[priority] ?? PRIORITY_EMOJI.medium;
  const obsDate = observationDate ? observationDate.slice(0, 10) : '';
  const refPart = referencedDate ? ` (ref: ${referencedDate.slice(0, 10)})` : '';
  return `${emoji} [${obsDate}]${refPart} ${content}`;
}

/**
 * Parse a formatted observation line back into its components.
 * @param {string} line
 * @returns {{ priority: string, observationDate: string, referencedDate: string|null, content: string }}
 */
export function parseObservation(line) {
  // Pattern: <emoji> [YYYY-MM-DD] (ref: YYYY-MM-DD)? <content>
  const emojiPattern = Object.keys(EMOJI_PRIORITY).join('|');
  // Use a regex that handles optional ref section
  const re = new RegExp(
    `^(${emojiPattern})\\s+\\[(\\d{4}-\\d{2}-\\d{2})\\](?:\\s+\\(ref:\\s*(\\d{4}-\\d{2}-\\d{2})\\))?\\s+(.+)$`,
    's'
  );
  const match = line.match(re);
  if (!match) {
    return { priority: 'medium', observationDate: null, referencedDate: null, content: line.trim() };
  }
  const [, emoji, observationDate, referencedDate, content] = match;
  return {
    priority: EMOJI_PRIORITY[emoji] ?? 'medium',
    observationDate,
    referencedDate: referencedDate ?? null,
    content: content.trim(),
  };
}

/**
 * Merge an array of formatted observation lines into a single string,
 * sorted ascending by observationDate.
 * @param {string[]} observations
 * @returns {string}
 */
export function mergeObservationLogs(observations) {
  if (!observations || observations.length === 0) return '';

  const sorted = [...observations].sort((a, b) => {
    const dateA = extractDate(a);
    const dateB = extractDate(b);
    if (dateA < dateB) return -1;
    if (dateA > dateB) return 1;
    return 0;
  });

  return sorted.join('\n');
}

/**
 * Extract the observationDate from a formatted line for sorting purposes.
 * @param {string} line
 * @returns {string}
 */
function extractDate(line) {
  const match = line.match(/\[(\d{4}-\d{2}-\d{2})\]/);
  return match ? match[1] : '';
}

/**
 * Estimate token count as ceil(text.length / 4).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Build a memory payload object for an observation node.
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.orgId
 * @param {string} opts.observationText - The full formatted observation text
 * @param {string} [opts.observationDate]
 * @param {string} [opts.referencedDate]
 * @param {string} [opts.project]
 * @param {string[]} [opts.sourceTags]
 * @returns {object}
 */
export function buildObservationPayload({
  userId,
  orgId,
  observationText,
  observationDate,
  referencedDate,
  project,
  sourceTags,
}) {
  return {
    memory_type: 'observation',
    userId,
    orgId,
    content: observationText,
    observationDate: observationDate ?? null,
    referencedDate: referencedDate ?? null,
    project: project ?? 'default',
    sourceTags: sourceTags ?? [],
    estimatedTokens: estimateTokens(observationText ?? ''),
    createdAt: new Date().toISOString(),
  };
}

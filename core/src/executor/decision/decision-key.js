// core/src/executor/decision/decision-key.js

import { createHash } from 'node:crypto';

/**
 * Normalize a string for decision key generation.
 * Lowercase, strip punctuation, collapse whitespace.
 * @param {string} str
 * @returns {string}
 */
export function normalizeForKey(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ')   // collapse whitespace
    .trim();
}

/**
 * Generate a canonical decision key for deduplication.
 * @param {string} project
 * @param {string} decisionType
 * @param {string} statement
 * @returns {string}
 */
export function generateDecisionKey(project, decisionType, statement) {
  const normalized = `${normalizeForKey(project)}:${normalizeForKey(decisionType)}:${normalizeForKey(statement)}`;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

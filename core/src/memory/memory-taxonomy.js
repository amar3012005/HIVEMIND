/**
 * Canonical semantic taxonomy for durable HIVEMIND memories.
 *
 * Evidence segments are not memories and therefore never receive one of these
 * types. Relationships are graph edges; `relationship` remains a legacy read
 * type only so existing rows and filters do not break.
 */
export const CANONICAL_MEMORY_TYPES = Object.freeze([
  'fact',
  'event',
  'decision',
  'preference',
  'goal',
  'commitment',
  'policy',
  'procedure',
  'lesson',
  'summary',
  'synthesis',
  'conversation',
]);

export const KB_MEMORY_TYPES = Object.freeze([
  'fact',
  'event',
  'summary',
  'synthesis',
  'conversation',
]);

export const LEGACY_MEMORY_TYPES = Object.freeze(['relationship']);

export const ACCEPTED_MEMORY_TYPES = Object.freeze([
  ...CANONICAL_MEMORY_TYPES,
  ...LEGACY_MEMORY_TYPES,
]);

export const MEMORY_TYPE_ALIASES = Object.freeze({
  note: 'fact',
  observation: 'fact',
  idea: 'fact',
  knowledge: 'fact',
  context: 'fact',
  contact: 'fact',
  person: 'fact',
  user: 'fact',
  task: 'commitment',
  todo: 'commitment',
  reminder: 'commitment',
  promise: 'commitment',
  requirement: 'policy',
  rule: 'policy',
  workflow: 'procedure',
  process: 'procedure',
  insight: 'lesson',
  learning: 'lesson',
  meeting: 'event',
  appointment: 'event',
  deadline: 'event',
});

export function normalizeMemoryType(value, { fallback = 'fact', allowLegacy = true } = {}) {
  const raw = String(value || '').trim().toLowerCase();
  const normalized = MEMORY_TYPE_ALIASES[raw] || raw;
  if (CANONICAL_MEMORY_TYPES.includes(normalized)) return normalized;
  if (allowLegacy && LEGACY_MEMORY_TYPES.includes(normalized)) return normalized;
  return fallback;
}

export function normalizeKbMemoryType(value, { conversationLike = false } = {}) {
  const normalized = normalizeMemoryType(value);
  if (normalized === 'conversation' && conversationLike) return normalized;
  if (KB_MEMORY_TYPES.includes(normalized) && normalized !== 'conversation') return normalized;
  return normalized === 'event' ? 'event' : 'fact';
}

/**
 * Native HIVE-MIND steps are never Composio toolkits. The progressive router
 * names the read lane `hivemind_context`; the compound planner uses
 * `hivemind-recall`. Any hivemind-* group is recall/save/projects, not OAuth.
 */
const CANONICAL = Object.freeze({
  'hivemind-recall': 'hivemind-recall',
  'hivemind-context': 'hivemind-recall',
  'hivemind-memory-write': 'hivemind-memory-write',
  'hivemind-memory': 'hivemind-memory-write',
  'hivemind-save': 'hivemind-memory-write',
  'hivemind-projects': 'hivemind-projects',
});

export function canonicalNativeToolGroup(group) {
  const normalized = String(group || '').trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return null;
  if (CANONICAL[normalized]) return CANONICAL[normalized];
  if (normalized.startsWith('hivemind-')) return 'hivemind-recall';
  return null;
}

export function isNativeHivemindGroup(group) {
  return canonicalNativeToolGroup(group) != null;
}

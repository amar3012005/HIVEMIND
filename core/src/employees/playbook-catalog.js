/**
 * Versioned playbook catalog. The engine does not keyword-route.
 * The HyperAgent calls PlaybookList then PlaybookGet.
 */
export const GLOBAL_PLAYBOOKS = Object.freeze([
  {
    id: 'global:general',
    name: 'General',
    description: 'Inspect this catalog, pick a more specific playbook, then execute it.',
    scope: 'global',
  },
  {
    id: 'global:prospect-discovery',
    name: 'Prospect Discovery',
    description: 'Discover, verify and qualify ICP-matching companies.',
    scope: 'global',
  },
  {
    id: 'global:market-research',
    name: 'Market Research',
    description: 'Map a market with sourced evidence and a written brief.',
    scope: 'global',
  },
  {
    id: 'global:competitive-analysis',
    name: 'Competitive Analysis',
    description: 'Compare named competitors on positioning, product, and GTM.',
    scope: 'global',
  },
]);

function safeScopedId(value, index, scope) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${scope}:${normalized || `${scope}-${index + 1}`}`;
}

/** Convert a scope-owned playbook payload into compact catalog entries.
 *
 * The durable room field predates this catalog and can be either one object,
 * an array, or `{ playbooks: [...] }`. Normalize at the catalog edge rather
 * than teaching the AgentScope runtime those legacy storage shapes.
 */
function scopedPlaybooks(value, scope) {
  const raw = Array.isArray(value)
    ? value
    : Array.isArray(value?.playbooks)
      ? value.playbooks
      : value ? [value] : [];
  return raw.map((entry, index) => {
    const object = entry && typeof entry === 'object' ? entry : {};
    const instructions = typeof entry === 'string'
      ? entry
      : String(object.instructions || object.content || object.text || '').trim();
    if (!instructions) return null;
    return {
      id: safeScopedId(object.id || object.slug || object.name, index, scope),
      name: String(object.name || object.title || `Organization playbook ${index + 1}`).trim(),
      description: String(object.description || 'Organization-specific operating guidance.').trim(),
      scope,
      instructions,
    };
  }).filter(Boolean);
}

export function organizationPlaybooks(value) {
  return scopedPlaybooks(value, 'org');
}

// A local overlay is supplied only in the durable WorkRun scope, and is read
// back only through the session-bound catalog endpoint.  It is intentionally
// distinct from the room's org playbooks: neither scope leaks into another
// WorkRun or becomes an always-injected system prompt.
export function localPlaybooks(value) {
  return scopedPlaybooks(value, 'local');
}

const BODIES = Object.freeze({
  'global:general': [
    'You are on the General playbook. First call PlaybookList.',
    'Choose the playbook whose description best matches the WorkRun goal.',
    'Then PlaybookGet that id and follow those instructions.',
    'Do not invent a playbook id. Do not classify by keyword lists in code — you are the resolver.',
  ].join('\n'),
  'global:prospect-discovery': [
    'Goal: a sourced list of companies that match the org ICP.',
    '1. hivemind_company_context',
    '2. hivemind_recall existing prospects',
    '3. TaskCreate the operating plan with blocked_by',
    '4. Web search + read; verify first-party sources',
    '5. hivemind_save_prospect for each qualified row',
    '6. hivemind_record_artifact the lead book',
    'Do not fabricate firms. Do not duplicate existing prospects.',
  ].join('\n'),
  'global:market-research': [
    'Goal: a sourced market brief.',
    'Read company context, TaskCreate, search, cite, write an artifact.',
    'Separate facts from inference.',
  ].join('\n'),
  'global:competitive-analysis': [
    'Goal: a comparison of named competitors with citations.',
    'Do not invent product claims. Record an artifact.',
  ].join('\n'),
});

export function listPlaybooks({ orgPlaybooks = [], localPlaybooks: local = [] } = {}) {
  return [...GLOBAL_PLAYBOOKS, ...orgPlaybooks, ...local]
    .map(({ id, name, description, scope }) => ({ id, name, description, scope }));
}

export function getPlaybook(id, { orgPlaybooks = [], localPlaybooks: local = [] } = {}) {
  const meta = [...GLOBAL_PLAYBOOKS, ...orgPlaybooks, ...local].find((p) => p.id === id);
  if (!meta) return null;
  return { ...meta, instructions: meta.instructions || BODIES[id] || '' };
}

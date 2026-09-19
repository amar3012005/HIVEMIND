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

export function listPlaybooks() {
  return GLOBAL_PLAYBOOKS.map(({ id, name, description, scope }) => ({ id, name, description, scope }));
}

export function getPlaybook(id) {
  const meta = GLOBAL_PLAYBOOKS.find((p) => p.id === id);
  if (!meta) return null;
  return { ...meta, instructions: BODIES[id] || '' };
}

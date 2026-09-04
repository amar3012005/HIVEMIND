export const NATIVE_CAPABILITY_FAMILIES = Object.freeze({
  profile: ['profile', 'update_profile'],
  memory_write: ['save', 'log_decision', 'set_assistant_name'],
  workspace_read: [
    'recall', 'source_read', 'event_range', 'snapshot', 'diff', 'timeline',
    'relation_between', 'aggregate', 'projects',
    'list_memories', 'get_memory', 'traverse', 'query_with_ai', 'count_where', 'query_table',
    'web_search', 'recall_bugs', 'why_code', 'code_at',
  ],
  direct: ['direct'],
});

export const NATIVE_OPERATION_TO_TOOL = Object.freeze({
  profile: 'get_user_profile',
  update_profile: 'update_user_profile',
  save: 'hivemind_save_memory',
  recall: 'hivemind_recall',
  source_read: 'hivemind_recall',
  event_range: 'hivemind_recall',
  snapshot: 'hivemind_at',
  diff: 'hivemind_diff',
  timeline: 'hivemind_timeline',
  relation_between: 'hivemind_relation_between',
  aggregate: 'hivemind_aggregate_entities',
  projects: 'hivemind_list_projects',
  list_memories: 'hivemind_list_memories',
  get_memory: 'hivemind_get_memory',
  traverse: 'hivemind_traverse_graph',
  query_with_ai: 'hivemind_query_with_ai',
  count_where: 'hivemind_count_where',
  query_table: 'hivemind_query_table',
  web_search: 'hivemind_web_search',
  recall_bugs: 'hivemind_recall_bugs',
  why_code: 'hivemind_why_code',
  code_at: 'hivemind_code_at',
  log_decision: 'hivemind_log_decision',
  set_assistant_name: 'hivemind_set_assistant_name',
  direct: null,
});

export const NATIVE_OPERATIONS = Object.freeze(Object.keys(NATIVE_OPERATION_TO_TOOL));

export const NATIVE_CAPABILITY_CARDS = Object.freeze({
  profile: {
    authority: 'caller_scoped', side_effect: 'conditional',
    use_when: 'Read or explicitly update the authenticated user or organization profile.',
    avoid_when: 'The subject is another person, a document, project knowledge, or general workspace history.',
  },
  memory_write: {
    authority: 'scoped_write', side_effect: 'write',
    use_when: 'Persist a user assertion as durable memory; leave destination null unless the user selected it.',
    avoid_when: 'The user asks a question or required write scope is unresolved.',
  },
  workspace_read: {
    authority: 'tenant_scoped_read', side_effect: 'none',
    use_when: 'Retrieve people, products, files, meetings, decisions, relations, projects, or temporal workspace knowledge.',
    avoid_when: 'The response is completely answerable from the current message without tenant context.',
  },
  respond_directly: {
    authority: 'none', side_effect: 'none',
    use_when: 'Greeting, acknowledgement, or transformation fully supplied by the current turn.',
    avoid_when: 'Profile, memory, evidence, source, time, entity, project, or connected context could change the answer.',
  },
});

export function compactCapabilityCatalog() {
  return Object.entries(NATIVE_CAPABILITY_FAMILIES)
    .map(([family, operations]) => {
      const card = NATIVE_CAPABILITY_CARDS[family === 'direct' ? 'respond_directly' : family];
      return `${family}: ${operations.join(', ')} | use: ${card.use_when} | avoid: ${card.avoid_when}`;
    })
    .join('\n');
}

export function capabilityForOperation(operation) {
  return Object.entries(NATIVE_CAPABILITY_FAMILIES).find(([, ops]) => ops.includes(operation))?.[0] || null;
}

export const WRITE_TOOLS = new Set([
  'hivemind_save_memory', 'hivemind_update_memory', 'hivemind_delete_memory',
  'hivemind_log_decision', 'hivemind_set_assistant_name',
]);

export const HIVEMIND_TOOL_GROUPS = {
  'hivemind-recall': {
    description: 'Tenant-scoped HIVEMIND memory, evidence, exact-source, entity aggregation, temporal recall and graph retrieval.',
    tools: new Set(['hivemind_recall', 'hivemind_relation_between', 'hivemind_aggregate_entities', 'hivemind_count_where', 'hivemind_query_table', 'hivemind_get_memory', 'hivemind_list_memories', 'hivemind_traverse_graph', 'hivemind_at', 'hivemind_diff', 'hivemind_timeline', 'hivemind_query_with_ai', 'get_user_profile', 'tara_call_get']),
  },
  'hivemind-memory-write': {
    description: 'Versioned HIVEMIND memory creation, update, deletion, decisions and assistant identity. Mutations are scoped and approval/policy checked.',
    tools: new Set(['hivemind_save_memory', 'hivemind_update_memory', 'hivemind_delete_memory', 'hivemind_log_decision', 'hivemind_set_assistant_name', 'update_user_profile']),
  },
  'hivemind-projects': {
    description: 'Authorized project discovery and project-aware memory placement.',
    tools: new Set(['hivemind_list_projects']),
  },
  'hivemind-web': {
    description: 'Explicit external web research and asynchronous crawl jobs.',
    tools: new Set(['hivemind_web_search', 'hivemind_web_crawl', 'hivemind_web_job_status', 'hivemind_brand_dna']),
  },
  'hivemind-engineering': {
    description: 'Engineering memory, bugs, code history and decision provenance.',
    tools: new Set(['hivemind_recall_bugs', 'hivemind_code_at', 'hivemind_why_code']),
  },
};

export function hivemindGroupFor(name) {
  return Object.entries(HIVEMIND_TOOL_GROUPS).find(([, group]) => group.tools.has(name))?.[0] || null;
}

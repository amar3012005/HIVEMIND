// The billing vocabulary is deliberately small and shared by every surface.
// `projection` points at the existing fast read models; UsageEvent is the
// durable source for all post-gate settlements.
export const USAGE_METRICS = Object.freeze({
  tokens: { metric: 'llm_tokens', month: 'tokensProcessed', daily: 'tokensProcessed', cumulative: 'tokens_processed' },
  searches: { metric: 'search_queries', month: 'searchQueries', daily: 'searchQueries', cumulative: 'search_queries' },
  uploads: { metric: 'knowledge_uploads', month: 'knowledgeBaseUploads', daily: 'knowledgeBaseUploads', cumulative: 'knowledge_base_uploads' },
  kbPages: { metric: 'knowledge_base_pages', month: 'knowledgeBasePages', daily: 'knowledgeBasePages', cumulative: 'knowledge_base_pages' },
  memories: { metric: 'memories_ingested', month: 'memoriesIngested', daily: 'memoriesIngested', cumulative: 'memories_ingested' },
  deepResearch: { metric: 'deep_research_jobs', month: 'deepResearchJobs', daily: 'deepResearchJobs', cumulative: 'deep_research_jobs' },
  webIntel: { metric: 'web_intel_jobs', month: 'webIntelJobs', daily: 'webIntelJobs', cumulative: 'web_intel_jobs' },
  graphQueries: { metric: 'graph_queries', month: 'graphQueries', daily: 'graphQueries', cumulative: 'graph_queries' },
  tara: { metric: 'tara_calls', month: 'taraUsage', daily: 'taraUsage', cumulative: 'tara_usage' },
  taraSeconds: { metric: 'tara_seconds', month: 'taraSeconds', daily: 'taraSeconds', cumulative: 'tara_seconds' },
  hyperAgentRuns: { metric: 'hyperagent_runs', month: 'hyperAgentRuns', daily: 'hyperAgentRuns', cumulative: 'hyper_agent_runs' },
  emailSends: { metric: 'email_sends', month: 'emailSends', daily: 'emailSends', cumulative: null },
  // Credits are the commercial allowance. They intentionally have no legacy
  // OrgUsage projection: usage_events is their authoritative ledger.
  credits: { metric: 'credits_consumed', month: null, daily: null, cumulative: null },
});

export function usageMetric(type) { return USAGE_METRICS[type] || null; }

/**
 * Hermes Agent template library — curated ephemeral-dispatch templates.
 *
 * Each entry provides:
 *   id            — stable slug used in POST /hermes/library/:id/run
 *   name          — display name
 *   blurb         — one-line description shown in the UI
 *   persona       — SOUL.md excerpt / system-prompt seed for this template
 *   suggestedTask — default task string when caller omits `task`
 *   skills        — capability badges for the UI (informational only)
 *   agentConfig   — partial HermesAgentConfig merged into the ephemeral dispatch.
 *                   Required fields (agent_id, name, tenant_id, hermes_profile,
 *                   status) are filled by the route at call-time; only template-
 *                   specific fields live here so the schema validator passes.
 *
 * memory_mode is always 'hivemind_mcp' — non-negotiable.
 *
 * @module hermes/library
 */

/** @type {Array<{id:string,name:string,blurb:string,persona:string,suggestedTask:string,skills:string[],agentConfig:object}>} */
export const LIBRARY = [
  {
    id: 'research-brief',
    name: 'Research Brief',
    blurb: 'Gathers structured research on any topic and stores a concise brief in HiveMind memory.',
    persona: 'You are a meticulous research analyst. Given a topic or question, produce a concise, well-sourced brief. Save the final output to HiveMind memory with clear headings.',
    suggestedTask: 'Research the latest developments in large language model alignment and produce a 3-section brief.',
    skills: ['web_search'],
    agentConfig: {
      memory_mode: 'hivemind_mcp',
      capabilities: ['web_search'],
      schedule: { type: 'manual' },
      output_routes: [], // filled by route with tenant-scoped route
      safety_policy: {
        max_tokens_per_run: 100000,
        max_runtime_seconds: 600,
      },
    },
  },
  {
    id: 'summarize-doc',
    name: 'Summarize Document',
    blurb: 'Reads a document or URL and saves a structured summary to HiveMind memory.',
    persona: 'You are an expert document analyst. Summarize the provided document or URL into key takeaways, action items, and open questions. Save to HiveMind memory.',
    suggestedTask: 'Summarize the document at the URL provided in the context field.',
    skills: ['browser', 'files'],
    agentConfig: {
      memory_mode: 'hivemind_mcp',
      capabilities: ['browser', 'files'],
      schedule: { type: 'manual' },
      output_routes: [],
      safety_policy: {
        max_tokens_per_run: 80000,
        max_runtime_seconds: 300,
      },
    },
  },
  {
    id: 'competitor-watch',
    name: 'Competitor Watch',
    blurb: 'Scans competitor websites and news, then saves a digest of changes to HiveMind memory.',
    persona: 'You are a competitive intelligence analyst. Find recent product updates, pricing changes, and blog posts from the named competitor. Produce a digest and save it to HiveMind memory tagged with "competitor".',
    suggestedTask: 'Search for the latest product and pricing news from the competitor named in the context field.',
    skills: ['web_search', 'browser'],
    agentConfig: {
      memory_mode: 'hivemind_mcp',
      capabilities: ['web_search', 'browser'],
      schedule: { type: 'manual' },
      output_routes: [],
      safety_policy: {
        max_tokens_per_run: 100000,
        max_runtime_seconds: 600,
        allowed_domains: ['*'],
      },
    },
  },
  {
    id: 'draft-reply',
    name: 'Draft Reply',
    blurb: 'Drafts a professional email or message reply based on context you provide.',
    persona: 'You are a senior communications specialist. Given a thread or context, draft a clear, professional reply. Do NOT send anything — only output the draft text and save it to HiveMind memory.',
    suggestedTask: 'Draft a polite follow-up reply to the email thread described in the context field.',
    skills: [],
    agentConfig: {
      memory_mode: 'hivemind_mcp',
      capabilities: [],
      schedule: { type: 'manual' },
      output_routes: [],
      safety_policy: {
        max_tokens_per_run: 40000,
        max_runtime_seconds: 180,
        require_approval: ['send'],
      },
    },
  },
  {
    id: 'data-qa',
    name: 'Data QA',
    blurb: 'Runs quality-assurance checks on a dataset or CSV and reports anomalies to HiveMind memory.',
    persona: 'You are a data quality engineer. Analyze the provided dataset or file for missing values, outliers, schema violations, and duplicates. Produce a QA report and save it to HiveMind memory.',
    suggestedTask: 'Run a data quality check on the CSV or dataset described in the context field and report any anomalies.',
    skills: ['files', 'code'],
    agentConfig: {
      memory_mode: 'hivemind_mcp',
      capabilities: ['files', 'code'],
      schedule: { type: 'manual' },
      output_routes: [],
      safety_policy: {
        max_tokens_per_run: 80000,
        max_runtime_seconds: 300,
      },
    },
  },
];

/** @param {string} id */
export function findTemplate(id) {
  return LIBRARY.find((t) => t.id === id) || null;
}

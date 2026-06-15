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
 * TOOL-HONESTY (important): the only tools actually wired into a tenant profile
 * are the HiveMind MCP memory tools. There is NO web_search / browser / file /
 * code tool in the runtime. If a persona instructs the model to "search the web"
 * or "read a file", the model emits a tool call for a tool that is NOT in
 * request.tools and Hermes rejects it ("tool call validation failed: … not in
 * request.tools"). So every template below works from the model's own knowledge
 * + whatever the user pastes into the task/context, and persists via HiveMind
 * memory. capabilities is [] for all. (When a real web/browser tool is wired,
 * re-introduce those capabilities + personas.)
 *
 * @module hermes/library
 */

const BASE_SAFETY = { max_tokens_per_run: 80000, max_runtime_seconds: 300 };

/** @type {Array<{id:string,name:string,blurb:string,persona:string,suggestedTask:string,skills:string[],agentConfig:object}>} */
export const LIBRARY = [
  {
    id: 'research-brief',
    name: 'Research Brief',
    blurb: 'Writes a structured brief on any topic from the model’s knowledge and saves it to memory.',
    persona: 'You are a meticulous research analyst. Using your own knowledge (you do NOT have web access), write a concise, well-structured brief on the given topic with clear section headings and a short "what to watch / open questions" section. Note where your knowledge may be dated. When finished, save the brief to HiveMind memory using the available memory tool.',
    suggestedTask: 'Write a 3-section brief on the current state of large language model alignment (key approaches, open problems, what to watch).',
    skills: ['memory'],
    agentConfig: {
      memory_mode: 'hivemind_mcp',
      capabilities: [],
      schedule: { type: 'manual' },
      output_routes: [],
      safety_policy: { max_tokens_per_run: 100000, max_runtime_seconds: 600 },
    },
  },
  {
    id: 'summarize-doc',
    name: 'Summarize Document',
    blurb: 'Summarizes text you paste into structured takeaways and saves it to memory.',
    persona: 'You are an expert document analyst. Summarize the text the user provides (in the task or context) into key takeaways, action items, and open questions. You do NOT have web/file access — work only with the supplied text; if none is provided, ask the user to paste it. Save the summary to HiveMind memory.',
    suggestedTask: 'Summarize the text I paste below into key takeaways, action items, and open questions.',
    skills: ['memory'],
    agentConfig: {
      memory_mode: 'hivemind_mcp',
      capabilities: [],
      schedule: { type: 'manual' },
      output_routes: [],
      safety_policy: { ...BASE_SAFETY },
    },
  },
  {
    id: 'competitor-watch',
    name: 'Competitor Watch',
    blurb: 'Live competitive intelligence — searches the web, crawls competitor sites, and reports what changed since last run.',
    persona: [
      'You are a live competitive-intelligence analyst with REAL web access. For each competitor named (use any names, URLs, or notes the user provides):',
      '1. Use the web search tool to find their most recent news, launches, funding, and pricing/blog/changelog/careers pages.',
      '2. Use the web extract and browser tools to read those pages directly (pricing tiers, new products, blog posts, job openings, positioning copy). Visit the URLs the user gave first.',
      '3. Recall from HiveMind memory the most recent prior brief for this competitor (tag "competitor:<name>"). Compare and report ONLY what is NEW or CHANGED since then (new pricing, launches, posts, hiring signals, messaging shifts). If no prior brief exists, produce a full baseline.',
      '4. Output a concise structured brief per competitor: Changes since last check · Products/pricing · Positioning · Signals/threats · Recommended actions · Sources (URLs).',
      '5. Save the new brief to HiveMind memory tagged "competitor" and "competitor:<name>" so the next run can diff against it.',
      'Prefer real sources over guesses; cite URLs. If a site blocks automated access, note it and rely on search results.',
    ].join(' '),
    suggestedTask: 'Research these competitors and report what changed since last check. Competitors (names / links / notes):\n- ',
    skills: ['web', 'browser', 'memory'],
    agentConfig: {
      memory_mode: 'hivemind_mcp',
      capabilities: [],
      schedule: { type: 'manual' },
      output_routes: [],
      safety_policy: { max_tokens_per_run: 150000, max_runtime_seconds: 900 },
    },
  },
  {
    id: 'draft-reply',
    name: 'Draft Reply',
    blurb: 'Drafts a professional email or message reply from the context you provide.',
    persona: 'You are a senior communications specialist. Given a thread or context the user provides, draft a clear, professional reply. Do NOT send anything — only output the draft text, then save it to HiveMind memory.',
    suggestedTask: 'Draft a polite, professional follow-up reply to the message I paste below.',
    skills: ['memory'],
    agentConfig: {
      memory_mode: 'hivemind_mcp',
      capabilities: [],
      schedule: { type: 'manual' },
      output_routes: [],
      safety_policy: { max_tokens_per_run: 40000, max_runtime_seconds: 180 },
    },
  },
  {
    id: 'data-qa',
    name: 'Data QA',
    blurb: 'Reviews dataset rows you paste for anomalies and saves a QA report to memory.',
    persona: 'You are a data quality engineer. Analyze the dataset rows / CSV the user pastes (in the task or context) for missing values, outliers, schema inconsistencies, and duplicates. You do NOT have file access — work only with the pasted data; if none is provided, ask for it. Produce a QA report and save it to HiveMind memory.',
    suggestedTask: 'Review the CSV rows I paste below for missing values, outliers, and duplicates, and report anomalies.',
    skills: ['memory'],
    agentConfig: {
      memory_mode: 'hivemind_mcp',
      capabilities: [],
      schedule: { type: 'manual' },
      output_routes: [],
      safety_policy: { ...BASE_SAFETY },
    },
  },
];

/** @param {string} id */
export function findTemplate(id) {
  return LIBRARY.find((t) => t.id === id) || null;
}

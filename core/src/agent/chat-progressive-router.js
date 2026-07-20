/**
 * Progressive tool-router (Claude-style capability disclosure) — FLAG-GATED.
 *
 * Replaces ONLY the intent-selection stage of /api/chat when
 * CHAT_ROUTER=progressive. The router picks ONE of six high-level capabilities
 * via a single Cerebras-direct call; a compact adapter compiles that choice
 * into the SAME `decision` shape parseChatIntent produces, which then flows
 * through the UNCHANGED intentDecisionToPlan → gatherEvidence → citation
 * validation → GPT-OSS synthesis pipeline. No behavior is duplicated; the six
 * tools are a thinner front-door, not a second orchestrator.
 *
 * Benchmarked: 96.7% routing accuracy, ~0.78s avg / 1.55s p95, ~1.3k tokens
 * (vs the current Gemini/GPT-OSS router at 69.6% / 2.47s). See
 * benchmarks/tool-routing/. Default OFF; the current planner remains primary
 * until the live end-to-end A/B gate passes.
 */

import { chatCompletionFetch } from '../llm/chat-provider.js';

// Router model: Cerebras-direct gpt-oss-120b (the hardened synthesis path).
// Env-overridable for A/B; falls back to the resolved synthesis model.
const ROUTER_MODEL = process.env.CHAT_PROGRESSIVE_ROUTER_MODEL || 'cerebras/gpt-oss-120b';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const nullable = (type) => ({ type: [type, 'null'] });

// ── The six high-level capability tools (validated schema from the benchmark).
export const HIGH_TOOLS = [
  { type: 'function', function: { name: 'hivemind_context', strict: true,
    description: 'Use for every workspace knowledge question: factual recall, named files, complete entity counts, relationships, timelines, changes, valid-time and known-time questions. This is the single grounded read capability.',
    parameters: object({
      operation: { type: 'string', enum: ['recall', 'source_read', 'aggregate', 'relation_between', 'temporal', 'diff', 'timeline'] },
      query_original: { type: 'string' }, query_canonical_en: { type: 'string' }, response_language: { type: 'string' },
      mode: { type: 'string', enum: ['fact', 'explain', 'full'] }, entities: { type: 'array', items: { type: 'string' } },
      source_title: nullable('string'), valid_at: nullable('string'), known_at: nullable('string'),
      range_start: nullable('string'), range_end: nullable('string'), aggregate_kind: nullable('string'),
    }) } },
  { type: 'function', function: { name: 'hivemind_memory', strict: true,
    description: 'Use for durable memory creation, versioned updates, deletion requests, decisions and assistant renaming. The server scopes, validates, confirms destructive actions and creates graph provenance.',
    parameters: object({
      operation: { type: 'string', enum: ['save', 'update', 'delete', 'rename_assistant'] }, response_language: { type: 'string' },
      title: nullable('string'), content: nullable('string'), target_query: nullable('string'), memory_id: nullable('string'),
      memory_type: nullable('string'), project_hint: nullable('string'), entities: { type: 'array', items: { type: 'string' } },
      event_time: nullable('string'), assistant_name: nullable('string'),
    }) } },
  { type: 'function', function: { name: 'hivemind_projects', strict: true,
    description: 'List or resolve only the projects authorized for this user and organization.',
    parameters: object({ query: nullable('string'), response_language: { type: 'string' } }) } },
  { type: 'function', function: { name: 'web_research', strict: true,
    description: 'Search or crawl the public web for current external information. Never use for workspace documents, email, Slack, Notion or internal memory.',
    parameters: object({ operation: { type: 'string', enum: ['search', 'crawl', 'job_status'] }, query: { type: 'string' }, url: nullable('string'), response_language: { type: 'string' } }) } },
  { type: 'function', function: { name: 'use_connector', strict: true,
    description: 'Select one connected application capability. Use only for live Gmail, Google Docs, Gemini, Slack, Notion, GitHub or Linear data/actions. Writes are converted to approval-required drafts.',
    parameters: object({
      provider: { type: 'string', enum: ['gmail', 'google-docs', 'google-gemini', 'slack', 'notion', 'github', 'linear'] },
      intent: { type: 'string', enum: ['read', 'write'] }, request: { type: 'string' }, response_language: { type: 'string' },
    }) } },
  { type: 'function', function: { name: 'respond_directly', strict: true,
    description: 'Use only for greetings, arithmetic, harmless general conversation, clarification questions, or safety refusals. Never use for workspace knowledge, memory writes, projects, web research or named connected applications.',
    parameters: object({ response: { type: 'string' }, response_language: { type: 'string' }, reason: { type: 'string', enum: ['general', 'clarification', 'safety_refusal'] } }) } },
];

// Token-lean system prompt: rules + a handful of multilingual routing examples
// (the benchmark's exact prompt — the examples are cheap and materially lift
// cross-language accuracy; broad example lists live in the eval suite, not here).
const SYSTEM = `You are HIVE, an enterprise assistant. You MUST call exactly one supplied high-level tool for every turn.
Use respond_directly only for greetings, arithmetic, clarification, or safety refusal.
Use hivemind_context for all internal knowledge: facts, named files, exact counts, relationships in every language, timelines and temporal questions.
Any explicit filename or file extension such as .pdf, .docx, .pptx, .xlsx, .md or .html is HIVEMIND source context, never a connector request. Only use a connector when the user explicitly names the connected application or asks to act in it.
Use hivemind_memory for remember/save/update/delete/rename requests in every language; never acknowledge a write without this tool.
Use hivemind_projects for project listing/resolution. Use web_research only for the public internet.
Use use_connector whenever Gmail, email, Google Docs, connected Gemini, Slack, Notion, GitHub or Linear is explicitly named. Connector writes are approval-gated drafts, so select them when requested but never claim they already executed.
Use hivemind_context operation=timeline for version history / change questions: "what was X before", "the previous value", "how has X changed", "show the timeline of X", "what did we update". operation=diff for "what changed between date A and B". operation=temporal for "what was true / known on date D".
Examples:
- "How are A and B related?", "Wie hangen A und B zusammen?", and Arabic equivalents => hivemind_context operation=relation_between.
- "What was the previous launch date?" / "What did the price used to be?" => hivemind_context operation=timeline.
- "List every X and exact count" => hivemind_context operation=aggregate.
- "Remember X" or "Recuerda X" => hivemind_memory operation=save.
- "Update X to Y" => hivemind_memory operation=update.
- "Find the Google Doc about X" => use_connector provider=google-docs intent=read.
- "Search Notion for X" => use_connector provider=notion intent=read.
Never invent workspace facts. Never bypass approval. Preserve exact entities, filenames, identifiers and dates. Respond in the user's language.`;

// capability.operation (router enum) → the current planner's operation enum.
// hivemind_context's temporal/diff → the existing 'timeline' op (gatherEvidence's
// temporal dispatch reads plan.time.* to choose _at/_diff/_timeline).
const CONTEXT_OP = {
  recall: 'recall', source_read: 'source_read', aggregate: 'aggregate',
  relation_between: 'relation_between', temporal: 'timeline', diff: 'timeline', timeline: 'timeline',
};

// Defense-in-depth bounds (the current planner runs normalizeIntentDecision;
// the adapter must not send unbounded/malformed values straight to the plan).
const s = (v, n = 2000) => (typeof v === 'string' ? v.slice(0, n) : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v) => (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim() : null);
const iso = (v) => (typeof v === 'string' && !Number.isNaN(new Date(v).getTime()) ? v : null);
// A self-referential query ("about me / my company") → the dedicated profile op
// (the router's hivemind_context enum has no 'profile'; detect it here so the
// caller-scoped get_user_profile path is preserved, not degraded to recall).
const PROFILE_RE = /\b(about me|about my (company|org|organi[sz]ation)|who am i|my (profile|preferences|role|goals))\b|über mich|meine firma|qui suis-je|sobre mí/i;

async function callRouter({ message, history, apiKey, signal }) {
  const histMsgs = Array.isArray(history)
    ? history.slice(-3).filter((h) => h && (h.role === 'user' || h.role === 'assistant') && h.content)
        .map((h) => ({ role: h.role, content: String(h.content).slice(0, 1200) }))
    : [];
  const resp = await chatCompletionFetch(ROUTER_MODEL, {
    method: 'POST',
    // chatCompletionFetch sets Authorization from the resolved route; no header here.
    body: JSON.stringify({
      messages: [{ role: 'system', content: SYSTEM }, ...histMsgs, { role: 'user', content: message }],
      tools: HIGH_TOOLS,
      tool_choice: 'required',
      parallel_tool_calls: false,
      temperature: 0,
      max_tokens: 900,
    }),
    signal,
  }, { fallbackApiKey: apiKey });
  if (!resp.ok) throw new Error(`progressive router ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const call = data.choices?.[0]?.message?.tool_calls?.[0] || null;
  let args = {};
  try { args = call ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
  return { tool: call?.function?.name || null, args, usage: data.usage };
}

/**
 * ADAPTER — compile the chosen high-level tool into the `decision` object shape
 * that intentDecisionToPlan expects. Returns { decision, usage }. The caller
 * runs intentDecisionToPlan(decision, message) exactly as for the current
 * planner, so ALL downstream behavior is identical.
 */
export function adaptToDecision(tool, args, message, language) {
  const lang = args?.response_language || language || 'und';
  const base = {
    version: 'chat-progressive.v1',
    confidence: 0.9,
    response_language: lang,
    query_original: args?.query_original || message,
    query_canonical_en: args?.query_canonical_en || args?.query || message,
    named_entities: Array.isArray(args?.entities) ? args.entities.filter(Boolean) : [],
    recall_mode: 'fact', source: null, aggregate: null, relation: null,
    save: null, update: null, delete: null, time: null, connector_provider: null,
    scope_filter: null, tool_groups: [], continuation: null, assistant_name: null,
    direct_response: null, project_prompt: null, acknowledgement: null, failure_response: null,
  };

  switch (tool) {
    case 'hivemind_context': {
      // Preserve the dedicated caller-scoped profile op for "about me/my org".
      if (args?.operation === 'recall' && PROFILE_RE.test(message)) {
        return { decision: { ...base, operation: 'profile', queries: [base.query_canonical_en], tool_groups: ['hivemind-recall'] }, usage: null };
      }
      const op = CONTEXT_OP[args?.operation] || 'recall';
      const time = (iso(args?.valid_at) || iso(args?.known_at) || iso(args?.range_start) || iso(args?.range_end))
        ? { valid_at: iso(args?.valid_at), known_at: iso(args?.known_at),
            range: (iso(args?.range_start) || iso(args?.range_end)) ? { start: iso(args?.range_start), end: iso(args?.range_end) } : null }
        : null;
      return { decision: {
        ...base,
        operation: op,
        queries: [base.query_canonical_en],
        recall_mode: ['fact', 'explain', 'full'].includes(args?.mode) ? args.mode : 'fact',
        source: s(args?.source_title, 512) ? { title: s(args.source_title, 512) } : null,
        aggregate: args?.operation === 'aggregate'
          ? { parent: s(base.named_entities[0] || base.query_canonical_en, 256), kind: s(args?.aggregate_kind, 128) || 'entity', requires_complete_coverage: true }
          : null,
        relation: args?.operation === 'relation_between' ? { entities: base.named_entities } : null,
        time,
        tool_groups: ['hivemind-recall'],
      }, usage: null };
    }
    case 'hivemind_memory': {
      const op = ['save', 'update', 'delete', 'rename_assistant'].includes(args?.operation) ? args.operation : 'save';
      return { decision: {
        ...base,
        operation: op,
        queries: [],
        save: op === 'save' ? { title: s(args?.title, 256), content: s(args?.content), tags: [], project_hint: s(args?.project_hint, 256) } : null,
        // memory_id must be a real UUID or null (never an entity name) — matches
        // the current planner's isUuid guard so update/delete can't target junk.
        update: op === 'update' ? { id: uuid(args?.memory_id), target_query: s(args?.target_query, 512), content: s(args?.content) } : null,
        delete: op === 'delete' ? { id: uuid(args?.memory_id), reason: null } : null,
        assistant_name: op === 'rename_assistant' ? s(args?.assistant_name, 80) : null,
        tool_groups: ['hivemind-memory-write'],
      }, usage: null };
    }
    case 'hivemind_projects':
      // Own group so buildToolkitForUser registers hivemind_list_projects.
      return { decision: { ...base, operation: 'recall', queries: [base.query_canonical_en], project_prompt: s(args?.query, 1000) || message, tool_groups: ['hivemind-projects', 'hivemind-recall'] }, usage: null };
    case 'web_research':
      // Web search is not yet wired into gatherEvidence (plan.needs_web is inert
      // on both routers). Route to recall HONESTLY rather than pretend a web
      // fetch happened — do NOT set needs_web. TODO: wire hivemind_web_search.
      return { decision: { ...base, operation: 'recall', queries: [s(args?.query, 2000) || message], tool_groups: ['hivemind-recall'] }, usage: null };
    case 'use_connector': {
      const write = args?.intent === 'write';
      const provider = s(args?.provider, 128);
      return { decision: {
        ...base,
        operation: write ? 'connector_write' : 'connector_read',
        queries: [s(args?.request, 2000) || message],
        connector_provider: provider,
        // The provider name IS the toolkit group name — buildToolkitForUser only
        // registers a connector's tools when selectedGroups includes the provider.
        // Empty groups (the bug) meant the connector was never registered.
        tool_groups: provider ? [provider] : [],
      }, usage: null };
    }
    case 'respond_directly':
    default:
      return { decision: {
        ...base,
        operation: 'direct',
        queries: [],
        direct_response: s(args?.response),
        failure_response: args?.reason === 'safety_refusal' ? s(args?.response) : null,
      }, usage: null };
  }
}

/**
 * Main entry — mirrors parseChatIntent's { decision, usage } contract so the
 * caller is a drop-in swap under the flag.
 */
export async function parseChatIntentProgressive({ message, history, language, apiKey, signal }) {
  try {
    const { tool, args, usage } = await callRouter({ message, history, apiKey, signal });
    const { decision } = adaptToDecision(tool, args, message, language);
    // Diagnostics for the A/B gate (read via trace.intent; harmless downstream).
    decision._router = 'progressive';
    decision._router_tool = tool;
    return { decision, usage };
  } catch (err) {
    // Fail safe: a router error must not break the turn — fall back to a plain
    // recall decision (same shape intentDecisionToPlan consumes; it recomputes
    // sub_queries from queries, so only `queries` is needed).
    return { decision: {
      version: 'chat-progressive.v1', operation: 'recall', confidence: 0,
      response_language: language || 'und', queries: [message],
      named_entities: [], query_original: message, query_canonical_en: message,
      recall_mode: 'fact', source: null, aggregate: null, relation: null, time: null,
      tool_groups: ['hivemind-recall'], _router: 'progressive', _router_error: err.message,
    }, usage: null };
  }
}

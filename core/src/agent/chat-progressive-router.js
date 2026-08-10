/**
 * Progressive tool-router (Claude-style capability disclosure) — LIVE DEFAULT.
 *
 * Replaces ONLY the intent-selection stage of /api/chat. Selected by
 * CHAT_ROUTER=progressive, which is the live production default as of the
 * 2026-07 flip (set CHAT_ROUTER=legacy to fall back to parseChatIntent, which
 * is kept in sync). The router picks ONE of seven high-level capabilities
 * via a single Cerebras-direct call; a compact adapter compiles that choice
 * into the SAME `decision` shape parseChatIntent produces, which then flows
 * through the UNCHANGED intentDecisionToPlan → gatherEvidence → citation
 * validation → GPT-OSS synthesis pipeline. No behavior is duplicated; the seven
 * tools are a thinner front-door, not a second orchestrator.
 *
 * Benchmarked: 96.7% routing accuracy, ~0.78s avg / 1.55s p95, ~1.3k tokens
 * (vs the current Gemini/GPT-OSS router at 69.6% / 2.47s). See
 * benchmarks/tool-routing/. The live A/B gate passed, so this is now the
 * default path; the legacy planner remains the maintained fallback.
 */

import { chatCompletionFetch } from '../llm/chat-provider.js';

// Router model: Cerebras-direct gpt-oss-120b (the hardened synthesis path).
// Env-overridable for A/B; falls back to the resolved synthesis model.
const ROUTER_MODEL = process.env.CHAT_PROGRESSIVE_ROUTER_MODEL || 'cerebras/gpt-oss-120b';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const nullable = (type) => ({ type: [type, 'null'] });

// ── The high-level capability tools.
export const HIGH_TOOLS = [
  { type: 'function', function: { name: 'hivemind_context', strict: true,
    description: 'Use for every workspace knowledge question: factual recall, named files, complete entity counts, relationships, timelines, changes, valid-time and known-time questions. This is the single grounded read capability.',
    parameters: object({
      operation: { type: 'string', enum: ['recall', 'source_read', 'aggregate', 'relation_between', 'temporal', 'diff', 'timeline'] },
      query_original: { type: 'string' }, query_canonical_en: { type: 'string' }, response_language: { type: 'string' },
      mode: { type: 'string', enum: ['fact', 'explain', 'full'] }, entities: { type: 'array', items: { type: 'string' } },
      source_title: nullable('string'), valid_at: nullable('string'), known_at: nullable('string'),
      range_start: nullable('string'), range_end: nullable('string'), aggregate_kind: nullable('string'),
      answer_type: { type: ['string', 'null'], enum: ['decision', 'goal', 'preference', 'lesson', 'event', 'relationship', 'fact', null], description: 'REQUIRED CLASSIFICATION: the KIND of memory the user is asking for, judged by MEANING in any language. decision=what was decided/agreed/chosen; goal=goals/targets/action items/next steps; preference=likes/dislikes/priorities; lesson=learnings/takeaways/postmortems; event=what happened/meetings/quotes; relationship=how entities relate; fact=objective attribute. null ONLY for generic lookups that fit none.' },
    }) } },
  { type: 'function', function: { name: 'hivemind_memory', strict: true,
    description: 'Use for durable memory creation, versioned updates, deletion requests, decisions and assistant renaming. The server scopes, validates, confirms destructive actions and creates graph provenance.',
    parameters: object({
      operation: { type: 'string', enum: ['save', 'update', 'delete', 'rename_assistant', 'update_profile'] }, response_language: { type: 'string' },
      title: nullable('string'), content: nullable('string'), target_query: nullable('string'), memory_id: nullable('string'),
      memory_type: nullable('string'), project_hint: nullable('string'), entities: { type: 'array', items: { type: 'string' } },
      event_time: nullable('string'), assistant_name: nullable('string'),
      // Explicit properties (NOT a bare object) — strict-mode structured output
      // rejects an object type with no properties.
      profile_name: nullable('string'), profile_role: nullable('string'), profile_company: nullable('string'),
      profile_language: nullable('string'), profile_location: nullable('string'),
      profile_preferences: { type: 'array', items: { type: 'string' } },
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
  { type: 'function', function: { name: 'use_campaign', strict: true,
    description: 'Create, inspect, improve, pause, or refresh an AI campaign. Creating one hands the work to a dedicated Campaign Room and never publishes automatically.',
    parameters: object({
      intent: { type: 'string', enum: ['read', 'write'] }, request: { type: 'string' }, response_language: { type: 'string' },
    }) } },
  { type: 'function', function: { name: 'compound_plan', strict: true,
    description: 'Use ONLY when the request requires MULTIPLE sequential steps across different capabilities that a single operation cannot express — e.g. recall knowledge, then create a Doc, then email it. Decompose into ordered subtasks. Each subtask names ONE connector group (tool_groups) and may depend on a prior subtask (depends_on). Never use for a single-step request.',
    parameters: object({
      subtasks: { type: 'array', items: object({
        operation: { type: 'string', description: 'Short label for this step, e.g. recall, create_doc, send_email.' },
        tool_groups: { type: 'array', items: { type: 'string' }, description: 'Connector group(s) for this step, e.g. ["hivemind-recall"], ["google-docs"], ["gmail"].' },
        depends_on: { type: ['array', 'null'], items: { type: 'integer' }, description: 'Indices of prior subtasks this step depends on, or null if independent.' },
        message: { type: 'string', description: 'The instruction for this single step, in the user\'s language, with exact identifiers preserved.' },
      }) },
      response_language: { type: 'string' },
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
Use hivemind_memory for remember/save/update/delete/rename requests in every language, AND for any durable fact the user simply ASSERTS - no request needed. A statement of fact about the user, their organisation, its products, people, naming or history is a save: \"Singulance was first known as Davinci AI\", \"X is our new pricing\", \"Y replaced Z\". The user is the authority on their own company, so a third-person claim still counts. Never acknowledge a write without this tool, and never reply \"would you like me to save this?\" - a new fact is additive, so store it and say you did. Deletion is the only write needing approval, and that is enforced in code by a one-time server token, not by asking. Questions, opinions and chit-chat are NOT saves. Distinguish the two "name" operations: "change MY name / my role / my company / I prefer X" => operation=update_profile (the USER's own profile). "Call yourself X / rename the assistant" => operation=rename_assistant (the ASSISTANT). Ambiguous "change it" with no clear target => ask ONE clarification via respond_directly(reason=clarification), never guess.
Use hivemind_projects for project listing/resolution. Use web_research only for the public internet.
ALWAYS classify answer_type on every hivemind_context call, by MEANING in the user's language: decisions/agreements/choices => decision; goals/targets/action items/next steps => goal; likes/preferences => preference; learnings/takeaways => lesson; things that happened, meetings, quotes => event; how entities relate => relationship; plain attribute lookups => fact or null. Asking WHAT WAS DECIDED is answer_type=decision even when the topic is pricing, dates, or vendors.
Use use_connector whenever Gmail, email, Google Docs, connected Gemini, Slack, Notion, GitHub or Linear is explicitly named. Connector writes are approval-gated drafts, so select them when requested but never claim they already executed.
Use use_campaign whenever the user asks to create, run, start, inspect, improve, pause, or check an AI campaign. Starting a campaign creates its dedicated Campaign Room; it does not publish. Use intent=write for create, regenerate, or pause and intent=read for list, status, or metrics.
Use hivemind_context operation=timeline for version history / change questions: "what was X before", "the previous value", "how has X changed", "show the timeline of X", "what did we update". operation=diff for "what changed between date A and B". operation=temporal for "what was true / known on date D".
DATES ARE MANDATORY on those two operations: with operation=diff you MUST fill range_start and range_end, and with operation=temporal you MUST fill valid_at (or known_at when the user asks what was KNOWN/recorded rather than what was true). Emit them as ISO yyyy-mm-dd, converting whatever the user wrote ("Aug 4", "4. August 2026", "last Tuesday"). Leaving these null turns a change question into a plain history walk and answers the wrong question.
Examples:
- "How are A and B related?", "Wie hangen A und B zusammen?", and Arabic equivalents => hivemind_context operation=relation_between.
- "What was the previous launch date?" / "What did the price used to be?" => hivemind_context operation=timeline.
- "List every X and exact count" (exhaustive enumeration of a category) => hivemind_context operation=aggregate.
- "What did we decide about X?" / "Was haben wir entschieden?" => hivemind_context operation=recall answer_type=decision.
- "What are the action items / next steps from the meeting?" => hivemind_context operation=recall answer_type=goal.
- "Which files/sources/documents mention X", "In which file is X described", "where is X mentioned" (SOURCE DISCOVERY — find which sources reference a named entity, NOT an exhaustive count) => hivemind_context operation=recall with mode=explain. Keep only the real entity name in named_entities; do NOT add words like file, source, document. This is NOT aggregate (aggregate is for counting members of a category, not locating an entity's sources).
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

// ── Deterministic temporal backstop ──────────────────────────────────────────
// The router is asked for range_start/range_end on a diff and valid_at on a
// point-in-time question, but hivemind_context is a `strict` tool whose every
// property is required, so the model satisfies the schema by emitting nulls.
// Measured on the live router: "What changed between 2026-08-04 and 2026-08-06?"
// routed correctly to operation=diff yet returned null dates, so `time` came out
// null and gatherEvidence's dispatch (react-agent-v2.js: t.range?.start →
// hivemind_diff, else valid_at → hivemind_at, else hivemind_timeline) fell
// through to hivemind_timeline. The trace proves it: tool_calls were
// hivemind_recall + hivemind_timeline, and the answer described a single date
// instead of a delta. A prompt instruction alone cannot fix this — the model
// already had one — so dates are also extracted from the raw message in code.
//
// Language-neutral by construction: ISO dates carry no language, and the month
// names cover the two languages this product actually ships in. Anything not
// recognised simply yields no dates and the existing behaviour is unchanged.
const MONTHS = {
  jan: 1, january: 1, januar: 1, feb: 2, february: 2, februar: 2, mar: 3, march: 3, marz: 3, märz: 3,
  apr: 4, april: 4, may: 5, mai: 5, jun: 6, june: 6, juni: 6, jul: 7, july: 7, juli: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, okt: 10, oktober: 10,
  nov: 11, november: 11, dec: 12, december: 12, dez: 12, dezember: 12,
};
const pad = (n) => String(n).padStart(2, '0');
// Returns ASCENDING unique ISO yyyy-mm-dd strings found in the text.
export function extractMessageDates(text, now = new Date()) {
  const src = String(text || '');
  if (!src) return [];
  const found = new Set();
  // 1. ISO — 2026-08-04 (unambiguous, language-independent).
  for (const m of src.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const [, y, mo, d] = m;
    if (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31) found.add(`${y}-${mo}-${d}`);
  }
  // 2. "Aug 4, 2026" / "August 4 2026" / "4. August 2026" / "4 Aug 2026".
  const names = Object.keys(MONTHS).join('|');
  const mdY = new RegExp(`\\b(${names})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi');
  const dMY = new RegExp(`\\b(\\d{1,2})\\.?\\s+(${names})\\.?(?:\\s+(\\d{4}))?\\b`, 'gi');
  const add = (mo, d, y) => {
    const month = MONTHS[String(mo).toLowerCase()];
    const day = Number(d);
    if (!month || !day || day > 31) return;
    // A bare "Aug 4" means the current year — the year the user is speaking in.
    found.add(`${y ? Number(y) : now.getUTCFullYear()}-${pad(month)}-${pad(day)}`);
  };
  for (const m of src.matchAll(mdY)) add(m[1], m[2], m[3]);
  for (const m of src.matchAll(dMY)) add(m[2], m[1], m[3]);
  return [...found].filter((v) => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())).sort();
}
// A self-referential query ("about me / my company") → the dedicated profile op
// (the router's hivemind_context enum has no 'profile'; detect it here so the
// caller-scoped get_user_profile path is preserved, not degraded to recall).
// Self-referential queries about the USER's own maintained profile → the
// dedicated caller-scoped profile op. Covers identity ("who am i / about me")
// AND the user's OWN attributes/goals/strategy/preferences, which live as
// structured profile facts (not well-embedded memory vectors), so plain recall
// mis-ranks them (audit: "my content marketing strategy" → recall → corpus
// mis-hit). The `my <attribute>` list is deliberately bounded to profile-type
// nouns so "my file/document/note/email" still route to recall, not profile.
// `my (…up to 3 qualifier words…) <profile-noun>` so "my content marketing
// strategy" / "my go-to-market plan" match, while the noun list stays bounded
// to profile-type attributes (file/document/note/email/meeting/competitor are
// NOT in it, so they still route to recall). Qualifiers are letters/hyphens only.
// Two arms:
//  (a) `my (…≤3 qualifiers…) <strong-noun>` — nouns unambiguous enough that a
//      qualified form is still about the user ("my content marketing strategy",
//      "my quarterly objectives"). "team/company/language/location" are NOT in
//      this arm (qualified forms like "my email to the team" are NOT profile).
//  (b) `my <profile-noun>` — the direct form, includes the weaker nouns.
// Identity/name questions are matched ONLY when tied to the first person
// (my name / what am i called / who am i), never a generic "the name of X" or
// "the file name" — those stay recall.
// Identity/name questions match ONLY on first-person forms ("my name",
// "what am i called", "who am i") — a generic "the name of X" / "the file name"
// stays recall. "What is my name" already contains the literal "my name".
const PROFILE_RE = /\b(about me|about my (company|org|organi[sz]ation)|who am i|what do you know about me|what am i called|my name)\b|\bmy(\s+[a-z-]+){0,3}\s+(profile|preferences?|role|title|position|name|goals?|objectives?|strateg(y|ies)|plans?|priorities|focus)\b|\bmy (profile|preferences?|role|title|position|name|goals?|objectives?|strateg(y|ies)|plans?|priorities|focus|company|organi[sz]ation|team|language|location)\b|über mich|was weißt du über mich|wie hei(ß|ss)e ich|mein name|meine (firma|rolle|ziele|strategie|präferenz)|qui suis-je|comment je m'appelle|mon (nom|rôle|objectif|entreprise)|sobre mí|cómo me llamo|mi (nombre|rol|empresa|objetivo)/i;

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
      let time = (iso(args?.valid_at) || iso(args?.known_at) || iso(args?.range_start) || iso(args?.range_end))
        ? { valid_at: iso(args?.valid_at), known_at: iso(args?.known_at),
            range: (iso(args?.range_start) || iso(args?.range_end)) ? { start: iso(args?.range_start), end: iso(args?.range_end) } : null }
        : null;
      // Backstop (see extractMessageDates): the router routes the OPERATION
      // correctly but frequently emits null dates, which silently downgraded
      // every diff to a version-chain walk. Recover the dates from the message
      // itself. Strictly additive — it runs ONLY when the model supplied no
      // usable date at all, so a model-provided value is never overridden, and
      // when no date can be parsed the value stays null and behaviour is
      // byte-identical to before.
      const rawOp = String(args?.operation || '');
      if (!time && (rawOp === 'diff' || rawOp === 'temporal')) {
        const dates = extractMessageDates(message);
        if (rawOp === 'diff' && dates.length >= 1) {
          // Two or more dates → the explicit window. One date → "what changed
          // since D"; gatherEvidence defaults a missing end to now.
          time = { valid_at: null, known_at: null,
            range: { start: dates[0], end: dates.length >= 2 ? dates[dates.length - 1] : null } };
        } else if (rawOp === 'temporal' && dates.length >= 1) {
          // Point-in-time: the LAST date named is the instant being asked about
          // ("what was true on D"), matching hivemind_at's valid_time axis.
          time = { valid_at: dates[dates.length - 1], known_at: null, range: null };
        }
        if (time) console.log(`[chat-router] temporal backstop: op=${rawOp} recovered ${JSON.stringify(time)} from message (model sent null dates)`);
      }
      return { decision: {
        ...base,
        operation: op,
        queries: [base.query_canonical_en],
        recall_mode: ['fact', 'explain', 'full'].includes(args?.mode) ? args.mode : 'fact',
        answer_type: ['decision', 'goal', 'preference', 'lesson', 'event', 'relationship', 'fact'].includes(String(args?.answer_type || '').toLowerCase()) ? String(args.answer_type).toLowerCase() : null,
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
      const op = ['save', 'update', 'delete', 'rename_assistant', 'update_profile'].includes(args?.operation) ? args.operation : 'save';
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
        // update_profile: the caller's own profile fields/preferences.
        profile_update: op === 'update_profile'
          ? {
              fields: Object.fromEntries(Object.entries({
                name: s(args?.profile_name, 200), role: s(args?.profile_role, 200),
                company: s(args?.profile_company, 200), language: s(args?.profile_language, 60),
                location: s(args?.profile_location, 200),
              }).filter(([, v]) => v)),
              preferences: Array.isArray(args?.profile_preferences) ? args.profile_preferences.filter((p) => typeof p === 'string' && p.trim()) : [],
            }
          : null,
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
    case 'use_campaign': {
      const write = args?.intent === 'write';
      return { decision: {
        ...base,
        operation: write ? 'connector_write' : 'connector_read',
        queries: [s(args?.request, 2000) || message],
        connector_provider: 'campaigns',
        tool_groups: ['campaigns'],
      }, usage: null };
    }
    case 'compound_plan': {
      // Multi-step request — the router decomposed it into ordered subtasks.
      // The caller (runReactAgentV2) routes this to the compound orchestrator
      // behind COMPOUND_ORCHESTRATOR_ENABLED. Each subtask is bounded here so
      // a malformed router output cannot carry unbounded payloads downstream.
      const raw = Array.isArray(args?.subtasks) ? args.subtasks : [];
      const subtasks = raw.slice(0, 8).map((st, i) => ({
        operation: s(st?.operation, 64) || `step_${i + 1}`,
        tool_groups: Array.isArray(st?.tool_groups)
          ? st.tool_groups.filter((g) => typeof g === 'string' && g).slice(0, 4).map((g) => s(g, 128))
          : [],
        depends_on: Array.isArray(st?.depends_on)
          ? st.depends_on.filter((d) => Number.isInteger(d) && d >= 0 && d < raw.length).slice(0, 4)
          : null,
        message: s(st?.message, 2000) || '',
      }));
      return { decision: {
        ...base,
        operation: 'compound',
        queries: [],
        subtasks,
        tool_groups: [],
      }, usage: null };
    }
    case 'respond_directly':
    default: {
      // ── Workspace-knowledge guard on respond_directly ────────────────────
      // respond_directly is documented as greetings / arithmetic / clarification
      // / safety only, and its own description says "Never use for workspace
      // knowledge". The router violates that on COMPOUND questions: measured
      // live, "What changed in my knowledge between Aug 4 and Aug 6 2026? Was
      // the Gmail pipeline working on August 1st?" selected respond_directly
      // with NO tool calls, and the model answered from its own parameters —
      // first inventing workspace facts outright, later (once grounding
      // tightened) refusing with "I don't have visibility ... my training only
      // includes data up to June 2024". Both are wrong: hivemind_diff answers
      // that question correctly when the same message is asked one clause at a
      // time. A single-clause temporal question routes fine, so this is a
      // routing miss on compound input, not a capability gap.
      //
      // Deterministic, not another prompt plea. Deliberately NARROW so it
      // cannot degrade the cases respond_directly legitimately owns:
      //   - reason must be 'general' — 'clarification' and 'safety_refusal' are
      //     never overridden, so refusals and questions-back are untouched.
      //   - the message must contain a REAL parsed date (extractMessageDates
      //     needs ISO or a month name + day; a bare year like "1969" does not
      //     match), which greetings and arithmetic do not have.
      //   - it must also read as a question about state/knowledge, so a plain
      //     statement like "let's meet on August 5" is NOT diverted.
      // If any of those fail, behaviour is byte-identical to before.
      const _reason = String(args?.reason || 'general');
      if (_reason === 'general') {
        const _msg = String(message || '');
        const _dates = extractMessageDates(message);
        // NEVER divert a WRITE into a read. The first version of this guard listed
        // 'change' and 'update' as state questions, but those are memory MUTATION
        // verbs: "change it to Aug 25th" carries a date AND that verb, so a
        // respond_directly pick would have been rewritten into a temporal recall and
        // the user's edit would have vanished with a confident-looking answer.
        // Note the word boundaries are deliberate — \bchange\b does not match
        // "changed"/"changes", so "what changed between A and B" is still a question.
        const _isWriteIntent = /\b(save|remember|store|note|add|create|change|update|set|rename|correct|delete|remove|forget)\b/i.test(_msg);
        const _asksAboutState = /\b(what|which|was|were|did|does|do|status|happened|happen|know|knowledge)\b/i.test(_msg);
        if (!_isWriteIntent && _dates.length >= 1 && _asksAboutState) {
          const _time = _dates.length >= 2
            ? { valid_at: null, known_at: null, range: { start: _dates[0], end: _dates[_dates.length - 1] } }
            : { valid_at: _dates[_dates.length - 1], known_at: null, range: null };
          console.log(`[chat-router] respond_directly overridden -> grounded temporal recall (dates=${JSON.stringify(_dates)}); the router tried to answer a workspace question from model parameters`);
          return { decision: {
            ...base,
            operation: 'timeline',   // gatherEvidence dispatches _diff/_at from time.*
            queries: [base.query_canonical_en],
            recall_mode: 'explain',
            time: _time,
            tool_groups: ['hivemind-recall'],
          }, usage: null };
        }
      }
      return { decision: {
        ...base,
        operation: 'direct',
        queries: [],
        direct_response: s(args?.response),
        failure_response: args?.reason === 'safety_refusal' ? s(args?.response) : null,
      }, usage: null };
    }
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

/**
 * Progressive tool-router (Claude-style capability disclosure) — LIVE DEFAULT.
 *
 * Replaces ONLY the intent-selection stage of /api/chat. Selected by
 * CHAT_ROUTER=progressive, which is the live production default as of the
 * 2026-07 flip (set CHAT_ROUTER=legacy to fall back to parseChatIntent, which
 * is kept in sync). The router picks ONE of seven high-level capabilities
 * via a single structured model call; a compact adapter compiles that choice
 * into the SAME `decision` shape parseChatIntent produces, which then flows
 * through the UNCHANGED intentDecisionToPlan → gatherEvidence → citation
 * validation → GPT-OSS synthesis pipeline. No behavior is duplicated; the seven
 * tools are a thinner front-door, not a second orchestrator.
 *
 * The router is intentionally one call. Native turns require dependable
 * semantic coverage classification as well as tool selection, so GPT-4.1 is
 * the primary structured planner; GPT-OSS Nitro remains the independent
 * fallback for availability.
 */

import { chatCompletionFetch } from '../llm/chat-provider.js';
import { getStaticPromptArtifact, promptContributionTelemetry } from './chat-static-prompt-cache.js';

// Router model: semantic routing errors can hide retained evidence by choosing
// a five-record window. Prefer the stronger structured planner for this one
// decision; it is env-overridable and has an independent Nitro fallback.
const ROUTER_MODEL = process.env.CHAT_PROGRESSIVE_ROUTER_MODEL || 'openai/gpt-4.1';
const ROUTER_FALLBACK_MODEL = process.env.CHAT_PROGRESSIVE_ROUTER_FALLBACK_MODEL || 'openai/gpt-oss-20b:nitro';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const nullable = (type) => ({ type: [type, 'null'] });

// ── The high-level capability tools.
export const HIGH_TOOLS = [
  { type: 'function', function: { name: 'hivemind_context', strict: true,
    description: 'Use for every workspace knowledge question: factual recall, known-item inventories, named files, certified complete entity counts, relationships, timelines, changes, valid-time and known-time questions. This is the single grounded read capability.',
    parameters: object({
      operation: { type: 'string', enum: ['recall', 'source_read', 'aggregate', 'relation_between', 'temporal_range', 'temporal', 'diff', 'timeline'] },
      temporal_semantics: { type: 'string', enum: ['none', 'event_window', 'snapshot_at', 'snapshot_diff', 'version_history'], description: 'Semantic temporal contract independent of language. event_window means records/activity occurring during a range; snapshot_at means workspace truth at one instant; snapshot_diff compares truth at two instants; version_history walks revisions.' },
      query_original: { type: 'string' }, query_canonical_en: { type: 'string', description: 'An intent-preserving English retrieval expression, not a punctuation-stripped copy. Include the requested subject, item/category type, and semantic facets needed to retrieve the answer. For broad inventories, include names/models/variants/categories or equivalent corpus vocabulary while preserving exact entities.' }, response_language: { type: 'string' },
      mode: { type: 'string', enum: ['fact', 'explain', 'full'] }, entities: { type: 'array', items: { type: 'string' } },
      answer_scope: { type: 'string', enum: ['exhaustive', 'broad', 'bounded'], description: 'Semantic coverage contract, independent of wording or language. exhaustive = the user needs the complete retained set of relevant claims/items, including a class of statements about a subject and material continued through conversation context; broad = several relevant facets or useful members; bounded = one answerable point. This controls the minimum evidence window, not writing style.' },
      answer_completion_requirement: { type: 'string', enum: ['complete_set', 'multi_facet', 'single_answer'], description: 'A second, independent semantic commitment. complete_set means the requested answer must collect every relevant retained member or claim of a category; multi_facet means it must cover multiple facets; single_answer means one answerable point. Choose this by the user meaning in any language, then make answer_scope agree: complete_set=exhaustive, multi_facet=broad, single_answer=bounded.' },
      response_depth: { type: 'string', enum: ['standard', 'detailed', 'comprehensive'], description: 'Semantic answer depth in any language. Standard is the default for ordinary requests; detailed is for meaningful breadth or multiple requested aspects; comprehensive is for a clearly thorough cross-source request or an exhaustive multi-item request that asks for detail about every member.' },
      retrieval_shape: { type: 'string', enum: ['fact', 'inventory', 'overview', 'comparison'], description: 'Language-independent retrieval shape. inventory means a useful list of known members/items; overview means multiple facets of one subject; comparison means explicit dimensions across subjects; fact is a bounded lookup.' },
      answer_objective: { type: 'string', description: 'Concise instruction describing exactly what the final answer must deliver and its requested shape. Do not answer the request here.' },
      source_title: nullable('string'), valid_at: nullable('string'), known_at: nullable('string'),
      range_start: nullable('string'), range_end: nullable('string'), aggregate_kind: nullable('string'),
      answer_type: { type: ['string', 'null'], enum: ['decision', 'goal', 'preference', 'lesson', 'event', 'relationship', 'fact', null], description: 'REQUIRED CLASSIFICATION: the KIND of memory the user is asking for, judged by MEANING in any language. decision=what was decided/agreed/chosen; goal=goals/targets/action items/next steps; preference=likes/dislikes/priorities; lesson=learnings/takeaways/postmortems; event=what happened/meetings/quotes; relationship=how entities relate; fact=objective attribute. null ONLY for generic lookups that fit none.' },
    }) } },
  { type: 'function', function: { name: 'hivemind_memory', strict: true,
    description: 'Use for durable memory creation, including stable facts or attributable assertions the user states without an explicit save command; also use for versioned updates, deletion requests, decisions and assistant renaming. Resolve third-person pronouns from conversation history before saving. Preserve an explicitly stated memory destination in scope: personal, organization, team, or project. Set scope to null when the user did not state a destination; the server then asks the user to choose. Never infer scope from the current page, profile, content, or project catalog. The server scopes, validates, confirms destructive actions and creates graph provenance.',
    parameters: object({
      operation: { type: 'string', enum: ['save', 'update', 'delete', 'rename_assistant', 'update_profile'] }, response_language: { type: 'string' },
      title: nullable('string'), content: nullable('string'), target_query: nullable('string'), memory_id: nullable('string'),
      memory_type: nullable('string'), project_hint: nullable('string'),
      scope: { type: ['string', 'null'], enum: ['personal', 'organization', 'team', 'project', null], description: 'Explicitly stated memory destination only. Null if the user did not state one.' },
      entities: { type: 'array', items: { type: 'string' } },
      event_time: nullable('string'), assistant_name: nullable('string'),
      admission_class: { type: 'string', enum: ['trusted_fact', 'user_assertion'], description: 'trusted_fact only for first-party facts the user can authoritatively establish about themselves or their organization; user_assertion for claims, descriptions, or opinions about another person.' },
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
    description: 'Select one connected application capability. Use only for live Gmail, Google Drive, Docs, Sheets, Calendar, Tasks, Gemini, Slack, Notion, GitHub or Linear data/actions. Writes are converted to approval-required drafts.',
    parameters: object({
      provider: { type: 'string', enum: ['gmail', 'google-drive', 'google-docs', 'google-sheets', 'google-calendar', 'google-tasks', 'google-gemini', 'slack', 'notion', 'github', 'linear'] },
      intent: { type: 'string', enum: ['read', 'write'] }, request: { type: 'string' }, response_language: { type: 'string' },
      result_order: { type: 'string', enum: ['provider_default', 'newest', 'oldest', 'soonest_upcoming'], description: 'Semantic ordering requested by the user in any language. Use soonest_upcoming for the next future event/task, newest for the latest past or current record.' },
      result_limit: { type: ['integer', 'null'], minimum: 1, maximum: 100 },
      has_explicit_filter: { type: 'boolean', description: 'True only when the user supplied a sender, entity, date, label, or content constraint; relative ordering words alone are not filters.' },
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
        intent: { type: 'string', enum: ['read', 'write'], description: 'Authority required by this step. Creating drafts, documents, events, messages, updates, or deletions is write; retrieval and lookup is read.' },
        output_kind: { type: 'string', enum: ['knowledge', 'recipient', 'record', 'document', 'message', 'generic'], description: 'Semantic result contract. Use recipient when this step must uniquely resolve a person/address for a later action; knowledge for HIVE-MIND recall; document/message for those provider artifacts; otherwise record or generic.' },
        tool_groups: { type: 'array', items: { type: 'string' }, description: 'Connector group(s) for this step, e.g. ["hivemind-recall"], ["google-docs"], ["gmail"].' },
        depends_on: { type: ['array', 'null'], items: { type: 'integer' }, description: 'Indices of prior subtasks this step depends on, or null if independent.' },
        message: { type: 'string', description: 'The instruction for this single step, in the user\'s language, with exact identifiers preserved.' },
        query: { type: ['string', 'null'], description: 'Compact canonical semantic query for retrieval/lookup steps, preserving the entity and requested attributes but excluding workflow verbs and downstream actions. Null for pure action steps.' },
        result_order: { type: 'string', enum: ['provider_default', 'newest', 'oldest', 'soonest_upcoming'] },
        result_limit: { type: ['integer', 'null'], minimum: 1, maximum: 100 },
        has_explicit_filter: { type: 'boolean' },
      }) },
      response_language: { type: 'string' },
    }) } },
  { type: 'function', function: { name: 'respond_directly', strict: true,
    description: 'Use only for greetings, arithmetic, harmless general conversation, clarification questions, or safety refusals. Never use for workspace knowledge, memory writes, projects, web research or named connected applications.',
    parameters: object({ response: { type: 'string' }, response_language: { type: 'string' }, reason: { type: 'string', enum: ['general', 'clarification', 'safety_refusal'] },
      // An explicit semantic certificate, rather than a language-specific
      // keyword guess. A direct answer is safe only when it is fully answerable
      // from the message/history and general knowledge — never from presumed
      // workspace state or an asserted lack of workspace state.
      context_free: { type: 'boolean', description: 'true only when the proposed reply is completely answerable from the user message/history and general knowledge. false whenever it asks about any person, company, project, file, event, decision, memory, record, or other possible workspace context.' },
    }) } },
];

const EXTERNAL_TOOL_NAMES = new Set(['use_connector', 'use_campaign', 'compound_plan']);
const NATIVE_TOOL_CATALOG = [
  'hivemind_recall — grounded facts, entity overviews, decisions, goals, events in a period, useful inventories, and named-file contents; not snapshots, state comparisons, histories, exact registries, or graph paths.',
  'hivemind_at — what was true or known at one instant; valid_time is truth/effective state and known_time is knowledge available by then; not events occurring during a range.',
  'hivemind_diff — compare workspace state at exactly two instants; not events during a period or a general history.',
  'hivemind_timeline — chronological versions, prior values, and how one subject evolved; not a one-date snapshot or two-date comparison.',
  'hivemind_aggregate_entities — certified exact count or registry-complete entity enumeration; ordinary useful lists use recall.',
  'hivemind_relation_between — verified relationship or graph path between at least two exact entities; ordinary multi-entity facts use recall.',
].join('\n');
// The native-only context contract exposes the exact server capability the
// planner intends to use. The high-level operation remains for compatibility,
// but native_tool is authoritative and prevents a vague "context" choice from
// fanning out across temporal, graph, aggregate, and recall tools.
const NATIVE_CONTEXT_TOOL = (() => {
  const context = HIGH_TOOLS.find((tool) => tool.function?.name === 'hivemind_context');
  return {
    ...context,
    function: {
      ...context.function,
      description: 'Plan exactly one grounded HIVE-MIND read. Select the single native capability that best matches the semantic request; ordinary recall already searches memories and document evidence together.',
      parameters: {
        ...context.function.parameters,
        properties: {
          native_tool: {
            type: 'string',
            enum: ['hivemind_recall', 'hivemind_at', 'hivemind_diff', 'hivemind_timeline', 'hivemind_aggregate_entities', 'hivemind_relation_between'],
            description: `Choose exactly one capability by semantic intent in any language:\n${NATIVE_TOOL_CATALOG}`,
          },
          temporal_axis: {
            type: 'string',
            enum: ['none', 'valid_time', 'known_time'],
            description: 'For hivemind_at only: valid_time means what was true/effective; known_time means what was known/recorded. none for all other tools.',
          },
          ...context.function.parameters.properties,
          // These fields are deliberately native-only. use_tools:true keeps
          // the established compound/Composio schema unchanged.
          temporal_semantics: {
            type: 'string',
            enum: ['none', 'latest', 'earliest', 'event_window', 'snapshot_at', 'snapshot_diff', 'version_history'],
            description: 'Semantic temporal contract independent of language. latest/earliest select an authorized record by stored event time; event_window means records/activity occurring during a range; snapshot_at means workspace truth at one instant; snapshot_diff compares truth at two instants; version_history walks revisions.',
          },
          referent_kind: {
            type: 'string',
            enum: ['person', 'organization', 'file', 'image', 'project', 'event', 'unknown'],
            description: 'What the request is about, classified semantically in the user language. A filename is file or image, not an entity aggregate.',
          },
          source_kind: {
            type: ['string', 'null'],
            enum: ['document', 'image', 'conversation', 'connector', null],
            description: 'Constrain a named or recency-selected source to this stored source class when applicable.',
          },
        },
        required: ['native_tool', 'temporal_axis', 'referent_kind', 'source_kind', ...context.function.parameters.required],
      },
    },
  };
})();

// A caller-scoped read that is intentionally native-only.  Unlike a generic
// recall query it has no model-supplied subject, user, org, or scope argument:
// the executor derives all identity from the authenticated request context.
// Keep it separate from HIGH_TOOLS so use_tools:true retains its established
// Composio/compound capability contract unchanged.
const NATIVE_PROFILE_TOOL = {
  type: 'function',
  function: {
    name: 'hivemind_profile',
    strict: true,
    description: 'Read the maintained profile of the authenticated caller and their organization. Use only when the semantic subject is the caller, their identity, role, company, preferences, goals, language, location, or maintained organization profile. Never use for another person referred to by name or by a third-person pronoun resolved from history. This is not document recall and takes no identifiers.',
    parameters: object({
      target: {
        type: 'string',
        enum: ['user', 'organization', 'user_and_organization'],
        description: 'Which maintained caller-scoped profile facts answer the request.',
      },
      query_original: { type: 'string' },
      response_language: { type: 'string' },
      answer_objective: { type: 'string' },
    }),
  },
};

// The initial router prompt stays small: native HIVE-MIND capabilities are
// always available, while connected apps and compound execution are disclosed
// only after the caller explicitly opts in for this turn.
export function getProgressiveTools({ useTools = false, connectedProviders = null } = {}) {
  if (!useTools) return [
    NATIVE_PROFILE_TOOL,
    NATIVE_CONTEXT_TOOL,
    ...HIGH_TOOLS.filter((tool) => !EXTERNAL_TOOL_NAMES.has(tool.function?.name)
      && tool.function?.name !== 'hivemind_context'),
  ];
  if (!Array.isArray(connectedProviders)) return HIGH_TOOLS;

  const allowed = [...new Set(connectedProviders
    .map((provider) => String(provider || '').trim().toLowerCase())
    .filter(Boolean))];
  return HIGH_TOOLS.flatMap((tool) => {
    if (tool.function?.name !== 'use_connector') return [tool];
    if (allowed.length === 0) return [];
    return [{
      ...tool,
      function: {
        ...tool.function,
        description: `Select one of this tenant's active connected application toolkits (${allowed.join(', ')}). Use its live data or prepare an approval-gated action.`,
        parameters: {
          ...tool.function.parameters,
          properties: {
            ...tool.function.parameters.properties,
            provider: { ...tool.function.parameters.properties.provider, enum: allowed },
          },
        },
      },
    }];
  });
}

function getWorkflowPlannerTool() {
  const compound = HIGH_TOOLS.find((tool) => tool.function?.name === 'compound_plan');
  return [{
    ...compound,
    function: {
      ...compound.function,
      description: 'Plan the complete user request as one or more bounded DAG steps. Include prerequisite reads, use exactly one tool group per step, preserve dependencies, and classify each semantic output contract. This plans only; it never executes actions.',
    },
  }];
}

// Token-lean system prompt: rules + a handful of multilingual routing examples
// (the benchmark's exact prompt — the examples are cheap and materially lift
// cross-language accuracy; broad example lists live in the eval suite, not here).
const SYSTEM = `You are HIVE, an enterprise assistant. You MUST call exactly one supplied high-level tool for every turn.
Use respond_directly only for greetings, arithmetic, clarification, or safety refusal. Set context_free=true only when the reply is fully answerable from the message/history and general knowledge. If a request could be answered by authorized workspace context — including any named or unnamed person, organization, product, file, project, event, decision, record, or prior work — it is NOT context-free: use hivemind_context. Never answer that you lack internal records without first using hivemind_context.
Use hivemind_context for all internal knowledge: facts, named files, exact counts, relationships in every language, timelines and temporal questions.
Any explicit filename or file extension such as .pdf, .docx, .pptx, .xlsx, .md or .html is HIVEMIND source context, never a connector request. Only use a connector when the user explicitly names the connected application or asks to act in it.
Use hivemind_memory for remember/save/update/delete/rename requests in every language, AND for any durable fact the user simply ASSERTS - no request needed. A statement of fact about the user, their organisation, its products, people, naming or history is a save: \"Singulance was first known as Davinci AI\", \"X is our new pricing\", \"Y replaced Z\". The user is the authority on their own company, so a third-person claim still counts. Never acknowledge a write without this tool, and never reply \"would you like me to save this?\" - a new fact is additive, so store it and say you did. Deletion is the only write needing approval, and that is enforced in code by a one-time server token, not by asking. Questions, opinions and chit-chat are NOT saves. Distinguish the two "name" operations: "change MY name / my role / my company / I prefer X" => operation=update_profile (the USER's own profile). "Call yourself X / rename the assistant" => operation=rename_assistant (the ASSISTANT). Ambiguous "change it" with no clear target => ask ONE clarification via respond_directly(reason=clarification), never guess.
Use hivemind_projects for project listing/resolution. Use web_research only for the public internet.
ALWAYS classify answer_type on every hivemind_context call, by MEANING in the user's language: decisions/agreements/choices => decision; goals/targets/action items/next steps => goal; likes/preferences => preference; learnings/takeaways => lesson; things that happened, meetings, quotes => event; how entities relate => relationship; plain attribute lookups => fact or null. Asking WHAT WAS DECIDED is answer_type=decision even when the topic is pricing, dates, or vendors.
For every hivemind_context call, first make TWO independent semantic coverage judgments in the user's language: (1) answer_completion_requirement: single_answer for one answerable point; multi_facet for several facets or a useful inventory; complete_set when the user needs every retained member or every relevant claim of a category about a subject, including material continued by a pronoun or ellipsis from conversation history. (2) answer_scope must agree: single_answer=>bounded, multi_facet=>broad, complete_set=>exhaustive. This is a coverage contract, not a keyword heuristic or a measure of how many records exist. If uncertain between levels, choose the broader level: omitting a supported member is worse than seeing extra grounded context. answer_scope sets a minimum response_depth: bounded => standard, broad => detailed, exhaustive => comprehensive. Do not return a smaller depth than that contract. Set answer_objective to exactly what the final response must deliver. An organization overview should synthesize identity, activity, products or positioning, and notable supported facts; a product request should enumerate and describe products rather than drift into general company background.
query_canonical_en must be a real semantic retrieval expression, not the user's sentence with punctuation removed. Preserve the exact subject and expand only the requested answer facets. For an inventory, include the category plus retrieval concepts such as names, models, variants and categories; for a comparison include the compared entities and dimensions; for a direct fact keep it narrow. This applies in every input language and must not add facts or entity names the user did not supply.
Set retrieval_shape from the semantic answer shape in every language: inventory for a useful list of known members/items, overview for a multi-facet subject overview, comparison for explicit comparison, otherwise fact.
Use operation=aggregate only when the user explicitly requires a certified exact count or exhaustive registry-complete enumeration. A request for a useful inventory of products, people, projects, or other known items from remembered context is operation=recall with response_depth=detailed; do not convert it to aggregate merely because its natural phrasing asks broadly what items exist.
Use use_connector whenever Gmail, email, Google Drive, Google Docs, Google Sheets, Google Calendar, Google Tasks, connected Gemini, Slack, Notion, GitHub or Linear is explicitly named. Connector writes are approval-gated drafts, so select them when requested but never claim they already executed.
For every connector read, classify ordering structurally in any language: a requested next future event/task means result_order=soonest_upcoming; last/latest/most recent means newest; earliest historical means oldest; otherwise provider_default. Ordering words are not content filters. Set has_explicit_filter=true only for an actual sender, entity, date, label, or content constraint, and set result_limit to the number of records requested (1 for one item).
Use use_campaign whenever the user asks to create, run, start, inspect, improve, pause, or check an AI campaign. Starting a campaign creates its dedicated Campaign Room; it does not publish. Use intent=write for create, regenerate, or pause and intent=read for list, status, or metrics.
Use hivemind_context operation=timeline for version history / change questions: "what was X before", "the previous value", "how has X changed", "show the timeline of X", "what did we update". Use operation=diff only to compare workspace state at two instants: "what changed between date A and B". Use operation=temporal for a point-in-time snapshot: "what was true / known on date D". Use operation=temporal_range for events, work, meetings, decisions, messages, records, or other activity that occurred during a period such as yesterday, today, last week, or the last N days.
DATES ARE MANDATORY on temporal_range, diff, and temporal. For temporal_range fill range_start and range_end with the inclusive event-time window. "Last N days" means exactly N UTC calendar dates including today, so its start is CURRENT_UTC_DATE minus N-1 days. For diff fill both comparison instants. For temporal fill valid_at (or known_at when the user asks what was KNOWN/recorded rather than what was true). Emit ISO timestamps, resolving relative expressions against CURRENT_UTC_DATE supplied in the dynamic policy. Never turn an activity window into an as-of snapshot or a snapshot diff.
Always set temporal_semantics consistently: event_window for activity/records during a period, snapshot_at for truth at one instant, snapshot_diff only for comparing state, version_history for revisions, and none for non-temporal recall. temporal_semantics is authoritative when operation and temporal meaning disagree.
Examples:
- "How are A and B related?", "Wie hangen A und B zusammen?", and Arabic equivalents => hivemind_context operation=relation_between.
- "What was the previous launch date?" / "What did the price used to be?" => hivemind_context operation=timeline.
- A certified exact count or explicitly registry-complete enumeration of X => hivemind_context operation=aggregate. A useful inventory of known X from workspace context => operation=recall with response_depth=detailed.
- "What did we decide about X?" / "Was haben wir entschieden?" => hivemind_context operation=recall answer_type=decision.
- "What are the action items / next steps from the meeting?" => hivemind_context operation=recall answer_type=goal.
- "Which files/sources/documents mention X", "In which file is X described", "where is X mentioned" (SOURCE DISCOVERY — find which sources reference a named entity, NOT an exhaustive count) => hivemind_context operation=recall with mode=explain. Keep only the real entity name in named_entities; do NOT add words like file, source, document. This is NOT aggregate (aggregate is for counting members of a category, not locating an entity's sources).
- "Remember X" or "Recuerda X" => hivemind_memory operation=save.
- "Update X to Y" => hivemind_memory operation=update.
- "Find the Google Doc about X" => use_connector provider=google-docs intent=read.
- "Search Notion for X" => use_connector provider=notion intent=read.
Never invent workspace facts. Never bypass approval. Preserve exact entities, filenames, identifiers and dates. Respond in the user's language.`;

const NATIVE_POLICY = `You are HIVE, the grounded organizational brain. You MUST call exactly one supplied high-level tool. Perform planning, semantic query optimization, tool selection, temporal normalization, answer-depth selection, and answer-shape selection in this ONE call.
Choose one minimal native route; never request every native tool and never create speculative hops.
- hivemind_profile: maintained identity/profile facts belonging to the authenticated user or organization profile, such as name, role, company, preferences, goals, language, or location. Use it only when the semantic subject is the caller or the caller's maintained organization profile. A third-person pronoun resolved from conversation history still refers to that other person and must never become a caller-profile read or write. It is caller-scoped by the server and takes no identifiers. Do not substitute a generic recall merely because profile facts may be absent; profile must run first. General company knowledge, products, documents, decisions, meetings, and history that are not maintained profile facts belong to recall.
For a grounded read, use hivemind_context and follow the native_tool catalog attached to that field; its descriptions are authoritative. Set operation to recall/source_read/temporal_range for hivemind_recall, temporal for hivemind_at, diff for hivemind_diff, timeline for hivemind_timeline, aggregate for hivemind_aggregate_entities, and relation_between for hivemind_relation_between. For a named file, preserve its closest recognizable title in source_title and use operation=source_read. For the latest/recent/first uploaded record, use hivemind_recall with temporal_semantics latest/earliest plus source_kind (image when it is an image); this is ordered retrieval, never a snapshot time-travel call. Set temporal_axis=valid_time or known_time only for hivemind_at and none otherwise.
query_canonical_en is the sole model-authored retrieval query. Make it a compact semantic expression that preserves the subject, requested attribute, qualifiers, negation, relationship direction, temporal boundary, and source title. Expand only the requested facets; never add guessed facts. For a multi-facet overview of exactly one named entity, use that exact entity or alias as the retrieval query and carry the requested facets in answer_objective; this maximizes coverage without losing what the final answer must cover. The server will not call a second query-rewrite model.
Select answer_completion_requirement and answer_scope before response_depth from semantic breadth, in any language. complete_set/exhaustive is required when the answer must collect every retained member or every relevant claim of a category about a subject; multi_facet/broad is required for a multi-aspect explanation, overview, comparison, or informative inventory; single_answer/bounded is only for one answerable point. If uncertain between levels, choose the broader level: omitting a supported member is worse than giving the synthesis more grounded context. The minimum response_depth is bounded => standard, broad => detailed, exhaustive => comprehensive. Standard exposes the unified top 5; detailed and comprehensive expose the unified top 15. Retrieval itself retains the top 15 in one pass. There is no later 5-to-10-to-15 hop.
Use hivemind_memory for explicit memory writes and for a stable declarative assertion the user contributes, even without words asking to save it. Resolve ellipsis and pronouns from conversation history and write a self-contained statement with the exact subject; never store an unresolved pronoun. Facts the user can authoritatively establish about themselves or their organization use admission_class=trusted_fact. A description, opinion, or factual claim about another person uses admission_class=user_assertion so it remains attributable to the user rather than becoming independently verified background. For memory writes, set scope only when the user explicitly names a destination. If the user says their personal memory, their organization/company memory, a team memory, or a named project, preserve that semantic destination in scope (and project_hint for a named project). Otherwise set scope=null; the server will ask the user where it belongs. Never infer a destination from active UI context, profile, content topic, or the project catalog. This semantic rule applies in every language. Questions and transient conversational reactions are not writes. Use hivemind_projects only to list or resolve authorized projects. Use web_research only for current public-internet information. Use respond_directly only for greetings, arithmetic, harmless general conversation, a necessary clarification, or a safety refusal; never use it for workspace knowledge. Mark context_free=true only when that direct response is fully determined by the message/history and general knowledge. Any question that could be answered from workspace context — including a named person, organization, product, file, project, event, decision, record, or prior work — must use hivemind_context with context_free=false.
Classify answer_type by meaning in the user's language: decision for choices or agreements; goal for targets, action items, or next steps; preference for priorities or likes; lesson for learnings; event for what happened, meetings, or quotes; relationship for entity connections; fact for objective attributes.
Never invent workspace facts, identifiers, filenames, entities, or dates. Preserve exact user constraints and answer in the user's language.`;

// capability.operation (router enum) → the current planner's operation enum.
// hivemind_context's temporal/diff → the existing 'timeline' op (gatherEvidence's
// temporal dispatch reads plan.time.* to choose _at/_diff/_timeline).
const CONTEXT_OP = {
  recall: 'recall', source_read: 'source_read', aggregate: 'aggregate',
  relation_between: 'relation_between', temporal_range: 'recall', temporal: 'timeline', diff: 'timeline', timeline: 'timeline',
};

// Defense-in-depth bounds (the current planner runs normalizeIntentDecision;
// the adapter must not send unbounded/malformed values straight to the plan).
const s = (v, n = 2000) => (typeof v === 'string' ? v.slice(0, n) : null);

/**
 * Server-owned native grounding boundary.
 *
 * The planner is useful for choosing a retrieval shape and canonical query,
 * but it is not an authority on whether a tenant has relevant context. Keep
 * this reusable because decisions can be normalized after the router adapter
 * before execution.
 */
export function enforceNativeGroundingDecision(decision, message, { useTools = false } = {}) {
  // A model must not bypass tenant-scoped knowledge with a direct answer.  The
  // profile operation is different: it is a server-owned, caller-scoped read
  // and is the authoritative first lane for questions about the caller.
  const bypassesNativeRecall = decision?.operation === 'direct';
  if (useTools === true || !bypassesNativeRecall) {
    return { decision, overridden: false };
  }
  const canonicalQuery = String(
    decision.query_canonical_en
    || decision.queries?.[0]
    || decision.answer_objective
    || message,
  ).trim() || message;
  return {
    decision: {
      ...decision,
      operation: 'recall',
      queries: [canonicalQuery],
      tool_groups: ['hivemind-recall'],
      direct_response: null,
      _native_direct_grounding_override: true,
      _native_knowledge_grounding_override: decision.operation,
    },
    overridden: true,
  };
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v) => (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim() : null);
const iso = (v) => (typeof v === 'string' && !Number.isNaN(new Date(v).getTime()) ? v : null);
const eventRange = (startValue, endValue) => {
  const start = iso(startValue);
  const end = iso(endValue);
  const anchor = start || end;
  if (!anchor) return null;
  const anchorDay = new Date(anchor).toISOString().slice(0, 10);
  const complete = !!(start && end);
  const startRaw = complete ? start : anchorDay;
  const endRaw = complete ? end : anchorDay;
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/;
  return {
    start: dayOnly.test(startRaw) ? `${startRaw}T00:00:00.000Z` : new Date(startRaw).toISOString(),
    end: dayOnly.test(endRaw) ? `${endRaw}T23:59:59.999Z` : new Date(endRaw).toISOString(),
  };
};

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

async function callRouter({ message, history, apiKey, signal, useTools = false, connectedProviders = null, workflowPlanner = false }) {
  const histMsgs = Array.isArray(history)
    ? history.slice(-3).filter((h) => h && (h.role === 'user' || h.role === 'assistant') && h.content)
        .map((h) => ({ role: h.role, content: String(h.content).slice(0, 1200) }))
    : [];
  const staticPrompt = getStaticPromptArtifact({
    family: 'chat-progressive-router',
    version: useTools ? 'v3' : 'v5',
    variant: useTools ? 'capability-contract' : 'native-single-call',
    build: () => useTools ? SYSTEM : NATIVE_POLICY,
  });
  const connectedPolicy = useTools && Array.isArray(connectedProviders)
    ? `For this tenant, the only active external connector groups are: ${connectedProviders.length ? connectedProviders.join(', ') : '(none)'}. Native HIVE-MIND capabilities remain available. Never plan an external connector group outside this active list. Add explicit prerequisite read steps whenever a later action needs an unresolved recipient, record ID, document link, channel, or other identifier; never invent it. For an email action, a person's name or display label is not a resolved destination: only a syntactically valid email address is resolved, otherwise add a recipient lookup step with output_kind recipient and make the action depend on it.`
    : '';
  const temporalPolicy = `CURRENT_UTC_DATE=${new Date().toISOString().slice(0, 10)}. Resolve relative dates semantically in the user's language and emit the required ISO temporal fields. A last-N-days inclusive window contains exactly N UTC dates: subtract N-1 days for range_start and use CURRENT_UTC_DATE for range_end.`;
  const dynamicPolicy = `${useTools
    ? connectedPolicy
    : 'Connected applications and compound execution are not enabled for this turn. Do not claim access to Gmail, Calendar, Docs, Slack, or any connected app; use grounded HIVE-MIND context when appropriate.'} ${temporalPolicy}`.trim();
  const workflowPolicy = workflowPlanner
    ? 'You are the hosted workflow planner. Call compound_plan exactly once, even for a one-step request. Decompose the complete request; do not answer it and do not select another capability. For every retrieval or lookup step, put a compact semantic retrieval expression in query, preserving entities and requested attributes while removing workflow verbs and later actions. Put null in query for pure action steps. A requested document, email, message, or other content artifact must receive substantive grounded content: when the current request supplies only a topic or refers to prior conversation, include the required knowledge-retrieval step and make the artifact depend on it rather than emitting a topic placeholder.'
    : '';
  const systemMessages = [
    { role: 'system', content: staticPrompt.value },
    ...(dynamicPolicy ? [{ role: 'system', content: dynamicPolicy }] : []),
    ...(workflowPolicy ? [{ role: 'system', content: workflowPolicy }] : []),
  ];
  const requestBody = {
    messages: [...systemMessages, ...histMsgs, { role: 'user', content: message }],
    tools: workflowPlanner ? getWorkflowPlannerTool() : getProgressiveTools({ useTools, connectedProviders }),
    tool_choice: workflowPlanner
      ? { type: 'function', function: { name: 'compound_plan' } }
      : 'required',
    parallel_tool_calls: false,
    temperature: 0,
    max_tokens: workflowPlanner ? 1400 : 900,
    prompt_cache_key: staticPrompt.key,
  };
  const routerModels = [...new Set([ROUTER_MODEL, ROUTER_FALLBACK_MODEL].filter(Boolean))];
  let data = null;
  let call = null;
  let usedModel = null;
  let lastError = null;
  for (const candidateModel of routerModels) {
    try {
      const resp = await chatCompletionFetch(candidateModel, {
        method: 'POST',
        // chatCompletionFetch sets Authorization from the resolved route; no header here.
        body: JSON.stringify(requestBody),
        signal,
      }, { fallbackApiKey: apiKey, useCase: 'chat_planner' });
      if (!resp.ok) throw new Error(`progressive router ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      data = await resp.json();
      call = data.choices?.[0]?.message?.tool_calls?.[0] || null;
      if (!call?.function?.name) throw new Error('progressive_router_missing_tool_call');
      usedModel = candidateModel;
      break;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) break;
    }
  }
  if (!call) throw lastError || new Error('progressive_router_all_models_failed');
  let args = {};
  try { args = call ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
  const dynamicPrompt = `${dynamicPolicy}\n${histMsgs.map((item) => item.content).join('\n')}\n${message}`;
  return {
    tool: call?.function?.name || null,
    args,
    usage: {
      ...(data.usage || {}),
      routing_model: usedModel,
      routing_fallback_used: usedModel !== ROUTER_MODEL,
      hivemind_prompt_cache: {
        static_prompt_cag: { key: staticPrompt.key, status: staticPrompt.cache, fingerprint: staticPrompt.fingerprint },
        provider_prefix: promptContributionTelemetry({ staticPrompt: staticPrompt.value, dynamicPrompt }),
      },
    },
  };
}

/**
 * ADAPTER — compile the chosen high-level tool into the `decision` object shape
 * that intentDecisionToPlan expects. Returns { decision, usage }. The caller
 * runs intentDecisionToPlan(decision, message) exactly as for the current
 * planner, so ALL downstream behavior is identical.
 */
export function adaptToDecision(tool, args, message, language, { useTools = false } = {}) {
  const lang = args?.response_language || language || 'und';
  const explicitScope = ['bounded', 'broad', 'exhaustive'].includes(args?.answer_scope)
    ? args.answer_scope
    : 'bounded';
  const completionScope = {
    single_answer: 'bounded',
    multi_facet: 'broad',
    complete_set: 'exhaustive',
  }[args?.answer_completion_requirement] || 'bounded';
  const scopeRank = { bounded: 0, broad: 1, exhaustive: 2 };
  // Both fields are model-authored semantic judgments from the single planner
  // call. Retain the more inclusive one if they disagree: this never changes
  // retrieval, only prevents a self-contradictory five-record answer window.
  const answerScope = scopeRank[completionScope] > scopeRank[explicitScope]
    ? completionScope
    : explicitScope;
  const requestedDepth = ['standard', 'detailed', 'comprehensive'].includes(args?.response_depth)
    ? args.response_depth
    : 'standard';
  const minimumDepth = { bounded: 'standard', broad: 'detailed', exhaustive: 'comprehensive' }[answerScope];
  const depthRank = { standard: 0, detailed: 1, comprehensive: 2 };
  const responseDepth = depthRank[requestedDepth] >= depthRank[minimumDepth]
    ? requestedDepth
    : minimumDepth;
  const namedEntities = Array.isArray(args?.entities) ? args.entities.filter(Boolean) : [];
  const retrievalShape = ['fact', 'inventory', 'overview', 'comparison'].includes(args?.retrieval_shape)
    ? args.retrieval_shape
    : 'fact';
  const plannerCanonicalQuery = args?.query_canonical_en || args?.query || message;
  // A one-subject overview is a coverage request, not a compound attribute
  // lookup. Keep its exact language-preserving entity as the retrieval anchor;
  // answer_objective below retains every facet requested by the user. This is
  // structural planner output, not a keyword or locale-specific rewrite.
  const entityAnchoredRecall = String(args?.native_tool || '') === 'hivemind_recall'
    && ['recall', 'source_read', 'temporal_range'].includes(String(args?.operation || 'recall'));
  const canonicalQuery = !useTools && entityAnchoredRecall && retrievalShape === 'overview' && namedEntities.length === 1
    ? namedEntities[0]
    : plannerCanonicalQuery;
  const base = {
    version: 'chat-progressive.v1',
    confidence: 0.9,
    response_language: lang,
    query_original: args?.query_original || message,
    query_canonical_en: canonicalQuery,
    named_entities: namedEntities,
    recall_mode: 'fact', source: null, referent: null, aggregate: null, relation: null,
    answer_scope: answerScope,
    response_depth: responseDepth,
    retrieval_shape: retrievalShape,
    answer_objective: s(args?.answer_objective, 1000) || message,
    save: null, update: null, delete: null, time: null, connector_provider: null,
    scope_filter: null, tool_groups: [], continuation: null, assistant_name: null,
    direct_response: null, project_prompt: null, acknowledgement: null, failure_response: null,
  };

  switch (tool) {
    case 'hivemind_context': {
      // Preserve the dedicated caller-scoped profile op for "about me/my org".
      // Native chat owns caller-profile reads. The previous `useTools` guard
      // inverted this and made the normal use_tools:false path fall through to
      // tenant recall, where profile facts are not guaranteed to be embedded.
      // Keep the external/Composio route unchanged.
      if (!useTools && args?.operation === 'recall' && PROFILE_RE.test(message)) {
        return { decision: { ...base, operation: 'profile', queries: [base.query_canonical_en], tool_groups: ['hivemind-recall'] }, usage: null };
      }
      const declaredOp = String(args?.operation || 'recall');
      const semanticOp = ({
        latest: 'recall',
        earliest: 'recall',
        event_window: 'temporal_range',
        snapshot_at: 'temporal',
        snapshot_diff: 'diff',
        version_history: 'timeline',
      })[String(args?.temporal_semantics || '')];
      const nativeOp = ({
        // Event windows are still a recall capability. Preserve the semantic
        // time contract even if the model used operation=recall alongside the
        // exact native tool (a valid but previously mis-normalized pairing).
        hivemind_recall: semanticOp === 'temporal_range' ? semanticOp : declaredOp,
        hivemind_at: 'temporal',
        hivemind_diff: 'diff',
        hivemind_timeline: 'timeline',
        hivemind_aggregate_entities: 'aggregate',
        hivemind_relation_between: 'relation_between',
      })[String(args?.native_tool || '')];
      const rawOp = nativeOp || semanticOp || declaredOp;
      const op = CONTEXT_OP[rawOp] || 'recall';
      let time = (iso(args?.valid_at) || iso(args?.known_at) || iso(args?.range_start) || iso(args?.range_end))
        ? { valid_at: iso(args?.valid_at), known_at: iso(args?.known_at),
            range: (iso(args?.range_start) || iso(args?.range_end)) ? { start: iso(args?.range_start), end: iso(args?.range_end) } : null }
        : null;
      if (time) {
        time.kind = rawOp === 'temporal_range'
          ? 'event_range'
          : rawOp === 'diff'
            ? 'snapshot_diff'
            : rawOp === 'temporal'
              ? 'snapshot_at'
              : 'version_timeline';
      }
      if (rawOp === 'temporal' && time) {
        const axis = String(args?.temporal_axis || 'none');
        if (axis === 'known_time') {
          const instant = time.known_at || time.valid_at;
          time = { valid_at: null, known_at: instant, range: null, kind: 'snapshot_at' };
        } else if (axis === 'valid_time') {
          const instant = time.valid_at || time.known_at;
          time = { valid_at: instant, known_at: null, range: null, kind: 'snapshot_at' };
        }
      }
      if (rawOp === 'temporal_range' && time?.range) {
        time = { ...time, valid_at: null, known_at: null, range: eventRange(time.range.start, time.range.end) };
      }
      // latest/earliest are retrieval-order contracts, not historical
      // snapshots. They deliberately carry no ISO instant: RecallRouter
      // resolves the newest/oldest authorized record by event/created time.
      if (['latest', 'earliest'].includes(String(args?.temporal_semantics || ''))) {
        time = {
          valid_at: null,
          known_at: null,
          range: null,
          kind: String(args.temporal_semantics),
          axis: 'event_time',
          order: args.temporal_semantics === 'latest' ? 'desc' : 'asc',
        };
      }
      // A temporal-range model response may provide one resolved ISO instant
      // instead of duplicating it into start/end. Treat that as the inclusive
      // UTC day. This is semantic-shape normalization only: the router already
      // chose temporal_range and resolved the user's language into ISO.
      if (rawOp === 'temporal_range' && time && !time.range && time.valid_at) {
        const day = time.valid_at.slice(0, 10);
        time = {
          valid_at: null,
          known_at: null,
          range: { start: `${day}T00:00:00.000Z`, end: `${day}T23:59:59.999Z` },
          kind: 'event_range',
        };
      }
      // Backstop (see extractMessageDates): the router routes the OPERATION
      // correctly but frequently emits null dates, which silently downgraded
      // every diff to a version-chain walk. Recover the dates from the message
      // itself. Strictly additive — it runs ONLY when the model supplied no
      // usable date at all, so a model-provided value is never overridden, and
      // when no date can be parsed the value stays null and behaviour is
      // byte-identical to before.
      if (!time && (rawOp === 'diff' || rawOp === 'temporal')) {
        const dates = extractMessageDates(message);
        if (rawOp === 'diff' && dates.length >= 1) {
          // Two or more dates → the explicit window. One date → "what changed
          // since D"; gatherEvidence defaults a missing end to now.
          time = { valid_at: null, known_at: null,
            kind: 'snapshot_diff',
            range: { start: dates[0], end: dates.length >= 2 ? dates[dates.length - 1] : null } };
        } else if (rawOp === 'temporal' && dates.length >= 1) {
          // Point-in-time: the LAST date named is the instant being asked about
          // ("what was true on D"), matching hivemind_at's valid_time axis.
          time = { valid_at: dates[dates.length - 1], known_at: null, range: null, kind: 'snapshot_at' };
        }
        if (time) console.log(`[chat-router] temporal backstop: op=${rawOp} recovered ${JSON.stringify(time)} from message (model sent null dates)`);
      }
      return { decision: {
        ...base,
        operation: op,
        // Retain the planner's native capability choice as first-class trace
        // data. `operation` remains the compatibility dispatch field used by
        // the existing executor, while this field proves that the one native
        // planning call selected the capability rather than a later heuristic.
        native_tool: useTools ? null : (String(args?.native_tool || '') || 'hivemind_recall'),
        temporal_axis: useTools ? null : (String(args?.temporal_axis || 'none')),
        queries: [base.query_canonical_en],
        recall_mode: ['fact', 'explain', 'full'].includes(args?.mode) ? args.mode : 'fact',
        answer_type: ['decision', 'goal', 'preference', 'lesson', 'event', 'relationship', 'fact'].includes(String(args?.answer_type || '').toLowerCase()) ? String(args.answer_type).toLowerCase() : null,
        // Source-read planners sometimes preserve an exact multilingual file
        // title in `entities[0]` while leaving the redundant source_title null.
        // Both are structured model output, so compile either representation
        // into the same source-isolated recall contract without keyword rules.
        source: s(args?.source_title, 512)
          ? { title: s(args.source_title, 512), kind: args?.source_kind || null }
          : rawOp === 'source_read' && s(base.named_entities[0], 512)
            ? { title: s(base.named_entities[0], 512), kind: args?.source_kind || null }
            : args?.source_kind
              ? { title: null, kind: args.source_kind }
              : null,
        referent: {
          kind: ['person', 'organization', 'file', 'image', 'project', 'event', 'unknown'].includes(args?.referent_kind)
            ? args.referent_kind : 'unknown',
          value: s(args?.source_title, 512) || s(base.named_entities[0], 512) || null,
        },
        aggregate: rawOp === 'aggregate'
          ? { parent: s(base.named_entities[0] || base.query_canonical_en, 256), kind: s(args?.aggregate_kind, 128) || 'entity', requires_complete_coverage: true }
          : null,
        relation: rawOp === 'relation_between' ? { entities: base.named_entities } : null,
        time,
        tool_groups: ['hivemind-recall'],
      }, usage: null };
    }
    case 'hivemind_profile':
      return { decision: {
        ...base,
        operation: 'profile',
        queries: [],
        answer_objective: s(args?.answer_objective, 1000) || message,
        profile_target: ['user', 'organization', 'user_and_organization'].includes(args?.target)
          ? args.target : 'user_and_organization',
        tool_groups: ['hivemind-recall'],
      }, usage: null };
    case 'hivemind_memory': {
      const op = ['save', 'update', 'delete', 'rename_assistant', 'update_profile'].includes(args?.operation) ? args.operation : 'save';
      return { decision: {
        ...base,
        operation: op,
        queries: [],
        save: op === 'save' ? {
          title: s(args?.title, 256), content: s(args?.content), tags: [],
          project_hint: s(args?.project_hint, 256),
          scope: ['personal', 'organization', 'team', 'project'].includes(args?.scope) ? args.scope : null,
          memory_type: s(args?.memory_type, 64) || 'fact',
          entities: Array.isArray(args?.entities) ? args.entities.map((entity) => s(entity, 256)).filter(Boolean) : [],
          event_time: iso(args?.event_time),
          admission_class: args?.admission_class === 'trusted_fact' ? 'trusted_fact' : 'user_assertion',
          confidence: 0.9,
        } : null,
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
      if (!useTools) return { decision: { ...base, operation: 'recall', queries: [message], tool_groups: ['hivemind-recall'] }, usage: null };
      const write = args?.intent === 'write';
      const provider = s(args?.provider, 128);
      return { decision: {
        ...base,
        operation: write ? 'connector_write' : 'connector_read',
        queries: [s(args?.request, 2000) || message],
        connector_provider: provider,
        connector_retrieval: {
          result_order: ['newest', 'oldest', 'soonest_upcoming'].includes(args?.result_order) ? args.result_order : 'provider_default',
          result_limit: Number.isInteger(args?.result_limit) ? Math.max(1, Math.min(100, args.result_limit)) : null,
          has_explicit_filter: args?.has_explicit_filter === true,
        },
        // The provider name IS the toolkit group name — buildToolkitForUser only
        // registers a connector's tools when selectedGroups includes the provider.
        // Empty groups (the bug) meant the connector was never registered.
        tool_groups: provider ? [provider] : [],
      }, usage: null };
    }
    case 'use_campaign': {
      if (!useTools) return { decision: { ...base, operation: 'recall', queries: [message], tool_groups: ['hivemind-recall'] }, usage: null };
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
      if (!useTools) return { decision: { ...base, operation: 'recall', queries: [message], tool_groups: ['hivemind-recall'] }, usage: null };
      // Multi-step request — the router decomposed it into ordered subtasks.
      // The caller (runReactAgentV2) routes this to the compound orchestrator
      // behind COMPOUND_ORCHESTRATOR_ENABLED. Each subtask is bounded here so
      // a malformed router output cannot carry unbounded payloads downstream.
      const raw = Array.isArray(args?.subtasks) ? args.subtasks : [];
      const subtasks = raw.slice(0, 8).map((st, i) => ({
        operation: s(st?.operation, 64) || `step_${i + 1}`,
        authority: st?.intent === 'write' ? 'write' : 'read',
        output_kind: ['knowledge', 'recipient', 'record', 'document', 'message', 'generic'].includes(st?.output_kind)
          ? st.output_kind : 'generic',
        tool_groups: Array.isArray(st?.tool_groups)
          ? st.tool_groups.filter((g) => typeof g === 'string' && g).slice(0, 4).map((g) => s(g, 128))
          : [],
        depends_on: Array.isArray(st?.depends_on)
          ? st.depends_on.filter((d) => Number.isInteger(d) && d >= 0 && d < raw.length).slice(0, 4)
          : null,
        message: s(st?.message, 2000) || '',
        query: s(st?.query, 500) || null,
        retrieval: {
          result_order: ['newest', 'oldest', 'soonest_upcoming'].includes(st?.result_order) ? st.result_order : 'provider_default',
          result_limit: Number.isInteger(st?.result_limit) ? Math.max(1, Math.min(100, st.result_limit)) : null,
          has_explicit_filter: st?.has_explicit_filter === true,
        },
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
      // Native HIVE chat is grounding-first. A model is not an authority for
      // deciding that a possible workspace question has no workspace answer:
      // the preceding context-free certificate was still a model assertion and
      // could be incorrectly marked true. For `use_tools:false`, every
      // non-safety direct selection therefore enters the single native recall
      // path. The final synthesizer can still answer a greeting naturally after
      // the bounded read, but no person/company/file/decision question can
      // bypass tenant-scoped recall. Connector/Composio routing is unchanged.
      if (useTools !== true) {
        return { decision: {
          ...base,
          operation: 'recall',
          queries: [base.query_canonical_en],
          tool_groups: ['hivemind-recall'],
        }, usage: null };
      }
      // A clarification is a semantic admission that the router is unsure; it
      // is not proof that workspace evidence is absent. Tool-enabled turns
      // retain the existing behavior below; native turns returned above.
      if (_reason === 'clarification') {
        return { decision: {
          ...base,
          operation: 'recall',
          queries: [base.query_canonical_en],
          tool_groups: ['hivemind-recall'],
        }, usage: null };
      }
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
export async function parseChatIntentProgressive({ message, history, language, apiKey, signal, useTools = false, connectedProviders = null, workflowPlanner = false }) {
  try {
    const { tool, args, usage } = await callRouter({ message, history, apiKey, signal, useTools, connectedProviders, workflowPlanner });
    const { decision } = adaptToDecision(tool, args, message, language, { useTools });
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
      response_depth: 'standard', answer_objective: message,
      retrieval_shape: 'fact',
      tool_groups: ['hivemind-recall'], _router: 'progressive', _router_error: err.message,
    }, usage: null };
  }
}

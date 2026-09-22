const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_MODEL = '~typesafe/jev-latest';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clip = (value, limit = 1200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

// JEV is a typed decision service, not a second chat agent.  Every caller
// must therefore give it the same small, explicit orientation packet instead
// of letting each graph node accidentally pass a different history shape.
// Keep provider schemas, credentials, and raw connected-app results out of
// this packet; those remain with the typed executor and receipt projector.
const STAGE_CONTEXT_CONTRACTS = Object.freeze({
  capability: 'Choose one initial intent from the user request, authenticated context, recent turns, and prior receipts. Do not execute or infer a provider action.',
  composio_selection: 'Choose one returned connected-app capability that advances the current unblocked outcome. Do not infer arguments, execute, or skip unmet dependencies.',
  composio_argument_review: 'Review only whether proposed schema-bound arguments preserve the request. Do not construct arguments, approve a write, or execute.',
  hivemind_meta_selection: 'Choose one read-only HIVE meta operation supported by the request and workflow state. Do not create or mutate memory.',
  hivemind_recall_filters: 'Choose retrieval filters only. Do not formulate a new request, retrieve records, or make a final claim.',
});

function compactDecisionTurns(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.filter(row => ['user', 'assistant'].includes(row?.role) && typeof row?.content === 'string')
    .slice(-10).map(row => ({ role: row.role, content: clip(row.content, 1400) }));
}

/**
 * Build the context shared by every JEV stage.  This is intentionally an
 * allow-list: graph state can contain full schemas and provider results, but
 * JEV needs only the decision-relevant projection.
 */
export function buildJevDecisionContext(stage, context = null) {
  const source = isObject(context) ? context : {};
  const recentTurns = compactDecisionTurns(Array.isArray(context)
    ? context
    : (source.recent_turns || source.conversation_history || source.conversation_context));
  const authenticatedScope = isObject(source.authenticated_scope) ? source.authenticated_scope : {};
  const workflow = isObject(source.workflow) ? source.workflow : {};
  return {
    context_version: 'jev-stage-context-v1',
    decision_contract: {
      stage,
      instruction: STAGE_CONTEXT_CONTRACTS[stage] || 'Make only the typed decision requested by this stage. Execution remains owned by the LangGraph executor.',
    },
    system_policy: clip(source.system_policy, 1800),
    authenticated_context: {
      locale: clip(source.locale || source.language, 40),
      profile: clip(source.profile, 1800),
      scope: boundedProjection({
        user_id: authenticatedScope.user_id || null,
        org_id: authenticatedScope.org_id || null,
        project_id: authenticatedScope.project_id || null,
      }, { maxChars: 600, maxDepth: 2, maxItems: 6 }),
    },
    recent_turns: recentTurns,
    workflow: boundedProjection({
      intent: source.current_intent || workflow.intent || null,
      phase: source.current_phase || workflow.phase || null,
      requested_outcomes: workflow.requested_outcomes || [],
      completed_receipts: workflow.completed_receipts || [],
      selected_tool_slugs: workflow.selected_tool_slugs || [],
      connection_scope: workflow.connection_scope || null,
      pending_action: workflow.pending_action || null,
    }, { maxChars: 7000, maxDepth: 5, maxItems: 16 }),
  };
}

function boundedProjection(value, { maxChars = 10000, maxDepth = 6, maxItems = 24 } = {}) {
  let stringLimit = 1400;
  const visit = (entry, depth = 0) => {
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'number') return entry;
    if (typeof entry === 'string') return entry.length > stringLimit ? `${entry.slice(0, stringLimit)}…` : entry;
    if (depth >= maxDepth) return '[nested value omitted]';
    if (Array.isArray(entry)) return entry.slice(0, maxItems).map(item => visit(item, depth + 1));
    if (isObject(entry)) return Object.fromEntries(Object.entries(entry).slice(0, maxItems)
      .map(([key, item]) => [clip(key, 100), visit(item, depth + 1)]));
    return null;
  };
  for (;;) {
    const projected = visit(value);
    if (JSON.stringify(projected).length <= maxChars) return projected;
    if (stringLimit <= 80) throw new Error('decision_state_exceeds_budget');
    stringLimit = Math.max(80, Math.floor(stringLimit / 2));
  }
}

function normalizeOptions(options) {
  if (!Array.isArray(options) || options.length < 2 || options.length > 32) {
    throw new TypeError('decision_options_must_contain_2_to_32_choices');
  }
  const seen = new Set();
  return options.map((option, index) => {
    if (!isObject(option)) throw new TypeError(`decision_option_${index}_invalid`);
    const id = clip(option.id, 160);
    const criteria = clip(option.criteria || option.description, 1200);
    if (!id || !criteria || seen.has(id)) throw new TypeError(`decision_option_${index}_invalid`);
    seen.add(id);
    return { id, criteria, ...(isObject(option.meta) ? { meta: option.meta } : {}) };
  });
}

function answerProbability(answer, choice) {
  const probability = Number(answer?.probabilities?.[choice]);
  return Number.isFinite(probability) ? probability : null;
}

function probabilityMargin(answer, choice) {
  const values = Object.entries(answer?.probabilities || {})
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([key, value]) => ({ key, value: Number(value) }))
    .sort((left, right) => right.value - left.value);
  const selected = values.find(item => item.key === choice)?.value;
  if (!Number.isFinite(selected)) return null;
  const runnerUp = values.find(item => item.key !== choice)?.value ?? 0;
  return selected - runnerUp;
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, outerSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(outerSignal?.reason);
  if (outerSignal?.aborted) abort();
  else outerSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('decision_provider_timeout')), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', abort);
  }
}

export function createOpenRouterJevProvider({
  apiKey = process.env.OPENROUTER_API_KEY,
  endpoint = process.env.JEV_DECISIONS_URL || DEFAULT_ENDPOINT,
  headers = {},
  model = process.env.JEV_MODEL || DEFAULT_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(process.env.JEV_TIMEOUT_MS || 5000),
  siteUrl = 'https://next.singulancelabs.com',
  siteName = 'HIVE-MIND Decision Gateway',
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('decision_provider_fetch_required');

  async function request({ state, questions, signal }) {
    const preparedHeaders = new Headers(headers || {});
    if (apiKey && !preparedHeaders.has('authorization') && !preparedHeaders.has('cf-aig-byok-alias')) {
      preparedHeaders.set('authorization', `Bearer ${apiKey}`);
    }
    // A Cloudflare AI Gateway service authorization is sufficient for a
    // configured custom provider. Do not require a BYOK header as well: the
    // provider may own its `default` credential selection internally.
    if (!preparedHeaders.has('authorization') && !preparedHeaders.has('cf-aig-byok-alias') && !preparedHeaders.has('cf-aig-authorization')) {
      throw new Error('decision_provider_api_key_missing');
    }
    preparedHeaders.set('content-type', 'application/json');
    preparedHeaders.set('http-referer', siteUrl);
    preparedHeaders.set('x-title', siteName);
    const response = await fetchWithTimeout(fetchImpl, endpoint, {
      method: 'POST',
      headers: preparedHeaders,
      body: JSON.stringify({ model, state: boundedProjection(state), questions }),
    }, timeoutMs, signal);
    if (!response.ok) throw new Error(`decision_provider_http_${response.status}:${clip(await response.text(), 240)}`);
    const payload = await response.json();
    if (!isObject(payload?.answers)) throw new Error('decision_provider_answers_missing');
    return { answers: payload.answers, usage: payload.usage || null, requestId: payload.id || null };
  }

  return {
    async decideChoice({ state, options, instructions, signal }) {
      const normalized = normalizeOptions(options);
      const optionMap = Object.fromEntries(normalized.map((option, index) => [`option_${index}`, option]));
      const result = await request({
        state,
        questions: {
          decision: {
            type: 'choice',
            instructions: clip(instructions, 1000),
            criteria: Object.fromEntries(Object.entries(optionMap).map(([key, option]) => [key, option.criteria])),
          },
        },
        signal,
      });
      const answer = result.answers.decision;
      const selected = optionMap[answer?.choice];
      if (answer?.type !== 'choice' || !selected) throw new Error('decision_provider_choice_invalid');
      return {
        choice: selected.id,
        probability: answerProbability(answer, answer.choice),
        margin: probabilityMargin(answer, answer.choice),
        probabilities: Object.fromEntries(Object.entries(answer.probabilities || {}).map(([key, value]) => [optionMap[key]?.id || key, value])),
        usage: result.usage,
        requestId: result.requestId,
      };
    },

    async decideQuestions({ state, questions, signal }) {
      const result = await request({ state, questions, signal });
      return result;
    },
  };
}

export function createDecisionTurnState(turnId = null) {
  return { turnId, disabled: false, fallbackReason: null, decisions: [] };
}

async function useFallback({ turn, fallback, reason, stage, input, diagnostics = null }) {
  turn.disabled = true;
  turn.fallbackReason ||= reason;
  const value = await fallback({ reason, stage, input });
  const receipt = { source: 'fallback', stage, reason, value, ...(diagnostics ? { diagnostics } : {}) };
  turn.decisions.push(receipt);
  return receipt;
}

export class DecisionGateway {
  constructor({ provider, minProbability = 0.8, minMargin = 0.2 } = {}) {
    if (!provider || typeof provider.decideChoice !== 'function') throw new TypeError('decision_provider_required');
    this.provider = provider;
    this.minProbability = minProbability;
    this.minMargin = minMargin;
  }

  async choose({ turn, stage, userQuery, context = null, observation = null, options, instructions, validate, fallback, signal }) {
    if (!turn || !Array.isArray(turn.decisions)) throw new TypeError('decision_turn_state_required');
    if (typeof fallback !== 'function') throw new TypeError('decision_fallback_required');
    const input = {
      userQuery: clip(userQuery, 4000),
      context: boundedProjection(buildJevDecisionContext(stage, context)),
      observation: boundedProjection(observation),
    };
    if (turn.disabled) return useFallback({ turn, fallback, reason: turn.fallbackReason || 'decision_gateway_disabled_for_turn', stage, input });
    try {
      const result = await this.provider.decideChoice({ state: { stage, ...input }, options, instructions, signal });
      if (!Number.isFinite(result.probability) || result.probability < this.minProbability) {
        return useFallback({ turn, fallback, reason: 'decision_probability_below_threshold', stage, input, diagnostics: result });
      }
      if (!Number.isFinite(result.margin) || result.margin < this.minMargin) {
        return useFallback({ turn, fallback, reason: 'decision_margin_below_threshold', stage, input, diagnostics: result });
      }
      const validation = typeof validate === 'function' ? await validate(result.choice, { input, result }) : true;
      if (validation !== true) return useFallback({ turn, fallback, reason: clip(validation || 'decision_rejected', 240), stage, input, diagnostics: result });
      const receipt = { source: 'jev', stage, choice: result.choice, probability: result.probability,
        margin: result.margin, probabilities: result.probabilities, usage: result.usage, requestId: result.requestId };
      turn.decisions.push(receipt);
      return receipt;
    } catch (error) {
      return useFallback({ turn, fallback, reason: clip(error?.message || error, 300), stage, input });
    }
  }
}

export const CAPABILITY_OPTIONS = Object.freeze([
  { id: 'direct_answer', criteria: 'Answer only from the current request, compact authenticated context, and recent turns. Select when no fresh retrieval, external application, web verification, or state change is needed. Never use for a request to save, update, search, send, or create.' },
  { id: 'hivemind_context', criteria: 'Read the authenticated user or organization profile: identity, role, company, mission, maintained preferences, locale, or location. This is profile/context lookup only; a requested change is hivemind_profile_update.' },
  { id: 'hivemind_memory_lookup', criteria: 'Read stored HIVE-MIND memories, decisions, documents, evidence, past work, or historical facts. Select when the user asks what HIVE knows, remembers, or has recorded about a subject. The executor must form a concrete recall query.' },
  { id: 'hivemind_entity_lookup', criteria: 'Resolve a named person, organization, project, product, document, or topic into a canonical HIVE entity before or instead of recall. Use when identity/entity relationships are the requested result, not merely a broad history summary.' },
  { id: 'hivemind_hyperagent_directory', criteria: 'Read the authenticated organization HyperAgent directory: agents, assignments, roles, ownership, availability, or digital employees. Do not use for general company memory or an external application.' },
  { id: 'hivemind_request', criteria: 'Perform a typed HIVE system request whose exact governed operation is determined by the HIVE meta contract, such as a time-aware, comparison, project, or evidence request that is not covered by the more specific intents.' },
  { id: 'hivemind_meta', criteria: 'Use the general HIVE meta toolkit only when the request is a HIVE-native read but does not clearly fit context, memory lookup, entity lookup, HyperAgent directory, or a typed HIVE request. It is read-only.' },
  { id: 'hivemind_profile_update', criteria: 'Change the authenticated user\'s maintained profile field, for example their own name, role, company, language, location, or timezone. This is a governed write and must not be used to save a general memory.' },
  { id: 'hivemind_save', criteria: 'Create one durable HIVE memory because the user explicitly asks to save, remember, retain, record, or file information that is already present in the request, recent turns, or completed governed receipts. The executor creates a source-grounded memory capsule and asks for a scope only if one was not stated. Do not select this when the same request first asks to retrieve, search, collect, read, verify, or pull information; that dependent read-plus-write request is multi_task.' },
  { id: 'composio_read', criteria: 'Read information from a connected external application such as email, calendar, files, CRM, messaging, source control, or social media. The executor must first discover capability, then select a read tool, load its schema, compile arguments, execute, and return a receipt.' },
  { id: 'composio_action', criteria: 'Create, update, send, publish, delete, or otherwise change data in a connected external application. The executor discovers the capability and schema, compiles arguments, requests approval for any write, executes only after approval, and returns a receipt.' },
  { id: 'composio_search', criteria: 'Use a connected external application, but the request does not yet establish whether the eventual provider operation is a read or write, or which toolkit capability is needed. Discover first; do not guess a provider, recipient, or tool.' },
  { id: 'web_research', criteria: 'Retrieve current public-web information when the user explicitly asks to search, verify, or research the web, or when internal HIVE evidence is explicitly insufficient and public verification is necessary.' },
  { id: 'multi_task', criteria: 'The request contains two or more materially distinct or dependent outcomes across HIVE, connected applications, web research, or writes. This includes requests such as retrieve/search/read/collect information and then save, send, update, compare, or otherwise act on it. Preserve every outcome: execute prerequisite reads first, use their governed receipts as evidence for any later write, then finish only after every requested outcome has a receipt.' },
  { id: 'workflow_plan', criteria: 'The user asks to design, sequence, coordinate, or explain a workflow rather than execute a settled provider-backed operation. Return an actionable plan without inventing external results or side effects.' },
  { id: 'fallback_harness', criteria: 'Use only when the request cannot be safely classified from the supplied request, compact context, recent turns, and receipts. This is an explicit unavailable-decision state, not permission to silently invoke an unconstrained tool loop.' },
]);

/** Explicit HIVE save commands are syntax, not a probabilistic routing task. */
export function hasExplicitHivemindSaveIntent(value) {
  const query = clip(value, 4000).toLowerCase();
  return /\b(?:save|store|file)\s+(?:this|that|it|the following)\s+(?:to|in|into)\s+(?:hive[- ]?mind|memory)\b/.test(query)
    || /\b(?:save|store)\s+(?:this|that|the following)\s+as\s+(?:a\s+)?memory\b/.test(query)
    || /\bremember\s+(?:this|that|the following)\b/.test(query);
}

export async function chooseCapability({ gateway, turn, userQuery, context, observation = null,
  appMentions = [], operationalAppIntent = false, fallback, signal }) {
  // App and save signals are evidence in the one plan node, never an external
  // deterministic router. JEV owns the capability choice for every turn.
  const planningContext = {
    ...(isObject(context) ? context : { recent_turns: Array.isArray(context) ? context : [] }),
    planning_hints: {
      app_mentions: [...new Set(appMentions.map(value => String(value).toLowerCase()))],
      operational_app_intent: operationalAppIntent === true,
      explicit_memory_save_language: hasExplicitHivemindSaveIntent(userQuery),
    },
  };
  return gateway.choose({ turn, stage: 'capability', userQuery, context: planningContext, observation, options: CAPABILITY_OPTIONS,
    instructions: 'Choose exactly one initial intent family. Use the request, compact system policy, authenticated profile, five recent turns, and bounded completed receipts as evidence. Never infer an app, recipient, tool, identifier, credential, fact, relationship, or external side effect. A request that asks to retrieve/search/read/collect information and then save, send, update, compare, summarize into a memory, or otherwise act on it is multi_task, even when both outcomes use HIVE-MIND. Do not collapse that request into hivemind_save or a single provider operation. Connected-app choices authorize generic discovery only, not execution. Completed receipts are authoritative: do not repeat them, and follow still-unsatisfied requested outcomes. Select fallback_harness only when no intent is safely supported; it must remain explicit and constrained.',
    fallback, signal });
}

function connectionStatuses(discovery) {
  return discovery?.toolkitConnectionStatuses || discovery?.toolkit_connection_statuses || {};
}

function disconnected(status) {
  if (status?.has_active_connection === false) return true;
  return /^(?:disconnected|missing|inactive)$/i.test(String(status?.status || status?.connection_status || status || ''));
}

function toolAuthority(tool) {
  if (tool?.function?.read_only === true || tool?._composio?.read_only === true) return 'read';
  const slug = String(tool?._composio?.slug || tool?.slug || '').toUpperCase();
  return /(?:SEND|CREATE|UPDATE|DELETE|REMOVE|PUBLISH|POST|REPLY|WRITE|ADD_)/.test(slug) ? 'write' : 'read';
}

export function projectComposioDiscovery(discovery = {}) {
  const statuses = connectionStatuses(discovery);
  const tools = (Array.isArray(discovery.tools) ? discovery.tools : []).slice(0, 24).map(tool => {
    const slug = String(tool?._composio?.slug || tool?.slug || tool?.function?.name || '').trim();
    const toolkit = String(tool?._composio?.toolkit || slug.split('_')[0] || '').toLowerCase();
    const schema = tool?.function?.parameters || tool?.input_schema || {};
    return {
      slug,
      toolkit,
      authority: toolAuthority(tool),
      description: clip(tool?.function?.description || tool?.description || slug, 700),
      required_fields: Array.isArray(schema.required) ? schema.required.slice(0, 24) : [],
      fields: isObject(schema.properties) ? Object.keys(schema.properties).slice(0, 40) : [],
      connected: !disconnected(statuses[toolkit]),
      schema,
      original: tool,
    };
  }).filter(tool => tool.slug);
  const connections = Object.entries(statuses).slice(0, 24).map(([toolkit, status]) => ({
    toolkit: toolkit.toLowerCase(), connected: !disconnected(status), status: clip(status?.status_message || status?.status || status, 500),
  }));
  return { sessionId: discovery.sessionId || null, workflowSessionId: discovery.workflowSessionId || null, tools, connections };
}

export function composioDecisionOptions(projection) {
  const options = [];
  for (const connection of projection.connections.filter(item => !item.connected)) {
    options.push({ id: `connect:${connection.toolkit}`, criteria: `The required ${connection.toolkit} capability is relevant but disconnected. Ask the existing connection handler to connect this toolkit and preserve the current session.` });
  }
  for (const tool of projection.tools) {
    options.push({ id: `use:${tool.slug}`, criteria: `${tool.authority.toUpperCase()} ${tool.toolkit} capability: ${tool.description} Required fields: ${tool.required_fields.join(', ') || 'none'}. Connection active: ${tool.connected}.`, meta: { tool } });
  }
  options.push({ id: 'ask_user', criteria: 'A necessary business identity or choice cannot be discovered from available connected capabilities or current context.' });
  options.push({ id: 'fallback_harness', criteria: 'No returned candidate safely satisfies the request; use the current selector with the same discovery result.' });
  return options;
}

export async function chooseComposioAction({ gateway, turn, userQuery, context, discovery, progress = null, fallback, signal }) {
  const projection = projectComposioDiscovery(discovery);
  const options = composioDecisionOptions(projection);
  return gateway.choose({
    turn, stage: 'composio_selection', userQuery, context,
    observation: { sessionId: projection.sessionId, connections: projection.connections, progress: boundedProjection(progress),
      tools: projection.tools.map(({ schema, original, ...tool }) => tool) },
    options,
    instructions: 'Choose the single next action that advances the original request using only returned candidates. A disconnected tool must use its connect option before execution. Select a read tool for retrieval and a write tool only when the request explicitly asks for that external change.',
    validate(choice) {
      if (!choice.startsWith('use:')) return true;
      const tool = projection.tools.find(item => item.slug === choice.slice(4));
      if (!tool) return 'selected_composio_tool_missing';
      if (!tool.connected) return `selected_composio_tool_disconnected:${tool.toolkit}`;
      return true;
    },
    fallback, signal,
  });
}

/**
 * Verify the final schema-bound arguments after discovery and tool selection.
 * This is toolkit-agnostic: JEV receives no provider credentials and never
 * constructs or executes provider arguments.
 */
export async function chooseComposioArgumentReview({ gateway, turn, userQuery, context, selectedTool, proposedArguments, progress = null, fallback, signal }) {
  const tool = selectedTool && typeof selectedTool === 'object' ? {
    slug: clip(selectedTool.slug, 180),
    toolkit: clip(selectedTool.toolkit, 100),
    authority: clip(selectedTool.authority, 40),
    description: clip(selectedTool.description, 700),
    schema: boundedProjection(selectedTool.schema || {}, { maxChars: 7000, maxDepth: 5, maxItems: 40 }),
  } : null;
  if (!tool?.slug) return useFallback({ turn, fallback, reason: 'selected_composio_tool_missing_for_argument_review', stage: 'composio_argument_review', input: { userQuery } });
  const options = [
    { id: 'execute', criteria: 'The proposed arguments conform to the selected schema and preserve every material filter, entity, ordering, time range, scope, and result count explicitly requested by the user.' },
    { id: 'regenerate', criteria: 'The selected tool can satisfy the request, but the proposed arguments omit, contradict, or add a material constraint. Regenerate only the schema argument object from the original request.' },
    { id: 'ask_user', criteria: 'The selected schema cannot safely express a material user constraint and no supported argument object can be inferred.' },
  ];
  return gateway.choose({
    turn,
    stage: 'composio_argument_review',
    userQuery,
    context,
    observation: {
      selected_tool: tool,
      proposed_arguments: boundedProjection(proposedArguments || {}, { maxChars: 7000, maxDepth: 5, maxItems: 40 }),
      progress: boundedProjection(progress),
    },
    options,
    instructions: 'Review only whether the proposed schema arguments preserve the original user request. Treat every named entity, identifier, status, date or time range, ordering, population, scope, and requested result count as material when explicit. Do not infer missing restrictions, credentials, or identifiers. Choose execute only when the object retains the requested meaning exactly; otherwise choose regenerate or ask_user. This is a validation decision, not tool execution authority.',
    fallback,
    signal,
  });
}

// A multi-task run remains inside the same LangGraph turn.  Once a governed
// read has produced evidence, JEV decides the *next* intent from a compact
// receipt projection.  It never receives raw provider schemas or authority to
// execute a tool; the graph continues to own those concerns.
export const WORKFLOW_TRANSITION_OPTIONS = Object.freeze([
  { id: 'hivemind_memory_lookup', criteria: 'Another HIVE memory retrieval is still a necessary prerequisite for an unsatisfied requested outcome.' },
  { id: 'hivemind_entity_lookup', criteria: 'Resolve a canonical HIVE entity before a remaining outcome can be grounded.' },
  { id: 'hivemind_save', criteria: 'The request explicitly asks to save, retain, record, or create a HIVE memory from the completed governed evidence. Create the source-grounded memory capsule next; scope or approval remains graph-governed.' },
  { id: 'composio_read', criteria: 'A further connected-app read is required to satisfy a remaining requested outcome.' },
  { id: 'composio_action', criteria: 'A requested connected-app change remains after its required evidence is available. The graph must still discover schema and request approval before execution.' },
  { id: 'web_research', criteria: 'A remaining requested outcome requires current public-web evidence.' },
  { id: 'synthesize', criteria: 'Every requested outcome is satisfied by the completed governed receipts. Produce the final answer from those receipts only.' },
  { id: 'ask_user', criteria: 'A material target, scope, recipient, or business choice is missing and cannot be discovered from the request, prior turns, or governed receipts.' },
  { id: 'fallback_harness', criteria: 'The next safe workflow step is not supported by the supplied request and receipts. Keep the fallback explicit and do not execute a tool.' },
]);

export async function chooseWorkflowTransition({ gateway, turn, userQuery, context, observation = null, fallback, signal }) {
  return gateway.choose({
    turn,
    stage: 'workflow_transition',
    userQuery,
    context,
    observation,
    options: WORKFLOW_TRANSITION_OPTIONS,
    instructions: 'Choose exactly one next intent for this already-admitted multi-task workflow. Use the original request, compact authenticated context, recent turns, and completed governed receipts. Preserve dependency order: never synthesize while an explicitly requested dependent outcome remains. A request to retrieve/search/read/collect and then save must select hivemind_save only after the source receipt exists. A selected write does not authorize execution: the graph still owns its schema, scope checkpoint, approval, idempotency, and receipt. Never repeat a completed receipt, invent an outcome, or use fallback as a hidden re-plan.',
    fallback,
    signal,
  });
}

export const HIVE_META_OPTIONS = Object.freeze([
  { id: 'entities', criteria: 'Resolve a named person, company, project, document, product, or subject to a canonical HIVE-MIND entity before retrieval.' },
  { id: 'recall', criteria: 'Retrieve stored memories, documents, decisions, evidence, or historical facts from the authenticated HIVE-MIND scope.' },
  { id: 'profiles', criteria: 'Return the exact authenticated organization HyperAgent directory for identification or assignment.' },
  { id: 'save_status', criteria: 'Check the status of a prior memory write using its exact idempotency key.' },
  { id: 'fallback_harness', criteria: 'No HIVE meta operation is clearly supported; use the current Harness tool-selection behavior.' },
]);

export async function chooseHiveMetaOperation({ gateway, turn, userQuery, context, fallback, signal }) {
  return gateway.choose({ turn, stage: 'hivemind_meta_selection', userQuery, context, options: HIVE_META_OPTIONS,
    instructions: 'Choose the one HIVE-MIND meta operation to expose next. Context and direct saves are handled by separate capability routes.', fallback, signal });
}

const RECALL_QUESTIONS = Object.freeze({
  retrieval: {
    type: 'choice', instructions: 'Choose the retrieval behavior required by the request.', criteria: {
      fast_fact: 'One bounded stable fact from memory is sufficient.',
      balanced: 'Use ordinary hybrid retrieval across relevant stored knowledge.',
      evidence: 'The answer needs grounded sources, document evidence, or conflict checking.',
      exhaustive: 'The user explicitly requests comprehensive or exhaustive coverage.',
    },
  },
  ordering: {
    type: 'choice', instructions: 'Choose the result ordering.', criteria: {
      relevance: 'Rank by semantic relevance.', newest: 'Return the newest matching records first.', oldest: 'Return the oldest matching records first.',
    },
  },
  temporal_axis: {
    type: 'choice', instructions: 'Choose how time in the request should be interpreted.', criteria: {
      none: 'No temporal snapshot is requested.', valid_time: 'The user asks what was true or effective at a particular time.', known_time: 'The user asks when HIVE learned or recorded the information.',
    },
  },
  include_superseded: {
    type: 'noul', instructions: 'Should superseded historical versions be included?', criteria: {
      true: 'The request asks about history, changes, prior states, corrections, or what used to be true.', false: 'Only the current best-known state is needed.',
    },
  },
});

export async function chooseHiveRecallPolicy({ gateway, turn, userQuery, context = null, fallback, signal }) {
  const stage = 'hivemind_recall_filters';
  const input = { userQuery: clip(userQuery, 4000), context: boundedProjection(buildJevDecisionContext(stage, context)) };
  if (turn.disabled) return useFallback({ turn, fallback, reason: turn.fallbackReason || 'decision_gateway_disabled_for_turn', stage, input });
  try {
    if (!gateway?.provider || typeof gateway.provider.decideQuestions !== 'function') throw new Error('decision_questions_provider_missing');
    const result = await gateway.provider.decideQuestions({ state: { stage, ...input }, questions: RECALL_QUESTIONS, signal });
    const answers = result.answers;
    const retrieval = answers?.retrieval?.choice;
    const ordering = answers?.ordering?.choice;
    const temporalAxis = answers?.temporal_axis?.choice;
    const includeSuperseded = Number(answers?.include_superseded?.noul);
    if (!['fast_fact', 'balanced', 'evidence', 'exhaustive'].includes(retrieval)
      || !['relevance', 'newest', 'oldest'].includes(ordering)
      || !['none', 'valid_time', 'known_time'].includes(temporalAxis)
      || !Number.isFinite(includeSuperseded)) throw new Error('hivemind_recall_decision_invalid');
    for (const [name, answer] of [['retrieval', answers.retrieval], ['ordering', answers.ordering], ['temporal_axis', answers.temporal_axis]]) {
      const probability = answerProbability(answer, answer.choice);
      const margin = probabilityMargin(answer, answer.choice);
      if (!Number.isFinite(probability) || probability < gateway.minProbability) throw new Error(`hivemind_recall_${name}_probability_below_threshold`);
      if (!Number.isFinite(margin) || margin < gateway.minMargin) throw new Error(`hivemind_recall_${name}_margin_below_threshold`);
    }
    const binaryConfidence = Math.max(includeSuperseded, 1 - includeSuperseded);
    const binaryMargin = Math.abs((2 * includeSuperseded) - 1);
    if (binaryConfidence < gateway.minProbability || binaryMargin < gateway.minMargin) {
      throw new Error('hivemind_recall_include_superseded_uncertain');
    }
    const receipt = { source: 'jev', stage, policy: { retrieval, ordering, temporal_axis: temporalAxis,
      include_superseded: includeSuperseded >= 0.8 }, answers, usage: result.usage, requestId: result.requestId };
    turn.decisions.push(receipt);
    return receipt;
  } catch (error) {
    return useFallback({ turn, fallback, reason: clip(error?.message || error, 300), stage, input });
  }
}

export function translateRecallPolicy(policy, runtime = 'core') {
  const mode = runtime === 'harness'
    ? ({ fast_fact: 'memory', balanced: 'auto', evidence: 'evidence', exhaustive: 'hybrid' })[policy.retrieval]
    : ({ fast_fact: 'fact', balanced: 'fact', evidence: 'explain', exhaustive: 'full' })[policy.retrieval];
  return {
    mode,
    sort: ({ relevance: 'score', newest: 'date_desc', oldest: 'date_asc' })[policy.ordering],
    include_superseded: policy.include_superseded,
    temporal_axis: policy.temporal_axis,
  };
}

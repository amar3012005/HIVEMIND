const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_MODEL = '~typesafe/jev-latest';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clip = (value, limit = 1200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

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
    if (!preparedHeaders.has('authorization') && !preparedHeaders.has('cf-aig-byok-alias')) {
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
    const input = { userQuery: clip(userQuery, 4000), context: boundedProjection(context), observation: boundedProjection(observation) };
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
  { id: 'direct_answer', criteria: 'The request can be answered from the current conversation and compact authenticated context without retrieving fresh information or changing state.' },
  { id: 'hivemind_context', criteria: 'Read only: the user asks about their current identity, organization, company profile, role, mission, ICP, location, or maintained preferences. Never select for a requested profile change.' },
  { id: 'hivemind_meta', criteria: 'The request needs HIVE-MIND recall, entity discovery, HyperAgent profiles, or the status of a prior memory save.' },
  { id: 'hivemind_profile_update', criteria: 'The user explicitly asks to change their own maintained profile field: name, role, company, language, location, or timezone. This is not a memory preference.' },
  { id: 'hivemind_save', criteria: 'The user explicitly asks to remember a stable fact, preference, decision, correction, relationship, or completed outcome as durable memory.' },
  { id: 'composio_search', criteria: 'The request needs information or an action in an external connected application such as email, calendar, files, CRM, messaging, or social media.' },
  { id: 'fallback_harness', criteria: 'None of the other choices is clearly supported; defer to the current chat model and tool-selection behavior.' },
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
  if (operationalAppIntent && appMentions.length) {
    const receipt = { source: 'deterministic', stage: 'capability', choice: 'composio_search',
      reason: 'explicit_operational_app_intent', appMentions: [...new Set(appMentions.map(value => String(value).toLowerCase()))] };
    turn.decisions.push(receipt);
    return receipt;
  }
  if (hasExplicitHivemindSaveIntent(userQuery)) {
    const receipt = { source: 'deterministic', stage: 'capability', choice: 'hivemind_save',
      reason: 'explicit_hivemind_save_intent' };
    turn.decisions.push(receipt);
    return receipt;
  }
  return gateway.choose({ turn, stage: 'capability', userQuery, context, observation, options: CAPABILITY_OPTIONS,
    instructions: 'Choose the one capability family that should be exposed next. Completed receipts in observation are authoritative: do not repeat them, and follow the order of the still-unsatisfied outcomes explicitly requested by the user. Select fallback_harness when the evidence does not clearly support another choice.',
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
  const input = { userQuery: clip(userQuery, 4000), context: boundedProjection(context) };
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

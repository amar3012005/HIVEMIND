import {
  DecisionGateway,
  chooseCapability,
  chooseComposioAction,
  chooseComposioArgumentReview,
  chooseWorkflowTransition,
  chooseMemoryType,
  chooseHiveMetaOperation,
  chooseHiveRecallPolicy,
  createDecisionTurnState,
  createOpenRouterJevProvider,
  translateRecallPolicy,
} from './decision-gateway.js';

const VALID_MODES = new Set(['off', 'shadow', 'active']);
const VALID_STAGES = new Set(['capability', 'composio_selection', 'composio_argument_review', 'workflow_transition', 'memory_type', 'hivemind_meta_selection', 'hivemind_recall_filters']);

function modeFromEnv(env) {
  const mode = String(env.JEV_DECISION_GATEWAY_MODE || 'off').trim().toLowerCase();
  return VALID_MODES.has(mode) ? mode : 'off';
}

function actorAllowlist(env) {
  return new Set(String(env.JEV_DECISION_GATEWAY_USER_IDS || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
}

// Shared only with isolated, non-interactive decision workflows. Callers still
// own their policy, authorization, and any side effect; this function exposes
// transport configuration, never a chat-routing decision.
export function decisionGatewayProviderConfig(env = process.env) {
  const explicit = String(env.JEV_DECISIONS_URL || '').trim();
  // JEV can use a dedicated OpenRouter credential without changing the
  // shared OPENROUTER_API_KEY used by chat, embeddings, visual generation,
  // and other Core services.
  const directJevKey = String(env.JEV_OPENROUTER_API_KEY || '').trim();
  if (directJevKey) {
    return {
      endpoint: explicit || 'https://openrouter.ai/api/alpha/decisions',
      apiKey: directJevKey,
      model: String(env.JEV_MODEL || '~typesafe/jev-latest').trim(),
      headers: {},
    };
  }
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const gatewayId = String(env.CLOUDFLARE_AI_GATEWAY_ID || '').trim();
  const gatewayToken = String(env.CLOUDFLARE_AI_GATEWAY_TOKEN || '').trim();
  const provider = String(env.JEV_GATEWAY_PROVIDER || 'custom-decision-jev').trim().toLowerCase();
  const alias = String(env.JEV_GATEWAY_BYOK_ALIAS || env.CLOUDFLARE_AI_GATEWAY_DECISION_JEV_BYOK_ALIAS || '').trim();
  const gatewayEnabled = String(env.CLOUDFLARE_AI_GATEWAY_ENABLED || '').toLowerCase() === 'true';
  if (!explicit && gatewayEnabled && accountId && gatewayId && gatewayToken && provider) {
    const base = String(env.CLOUDFLARE_AI_GATEWAY_BASE_URL || 'https://gateway.ai.cloudflare.com').replace(/\/+$/, '');
    // TypeSafe's native endpoint is /api/v1/systemone. OpenRouter exposes the
    // same typed Decisions contract separately, at /api/alpha/decisions. Do
    // not send JEV through chat completions: it does not generate text.
    const isOpenRouter = provider === 'custom-openrouter' || provider === 'openrouter';
    const path = String(env.JEV_GATEWAY_PATH || (isOpenRouter ? '/api/alpha/decisions' : '/api/v1/systemone')).replace(/^\/?/, '/');
    return {
      endpoint: `${base}/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/${encodeURIComponent(provider)}${path}`,
      apiKey: '',
      model: String(env.JEV_MODEL || (isOpenRouter ? 'typesafe/jev-1.13' : '')).trim() || undefined,
      headers: {
        'cf-aig-authorization': `Bearer ${gatewayToken}`,
        'cf-aig-skip-cache': 'true',
        // This production gateway explicitly exposes its decision credential
        // as the `default` alias. Forward the configured alias for every
        // provider rather than silently relying on a provider-side default.
        ...(alias ? { 'cf-aig-byok-alias': alias } : {}),
      },
    };
  }
  return { endpoint: explicit || undefined, apiKey: env.OPENROUTER_API_KEY, model: env.JEV_MODEL, headers: {} };
}

function finiteThreshold(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

function boundedString(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function fallbackReceipt(reason = 'current_selector') {
  return { source: 'fallback', choice: 'fallback_harness', reason };
}

export function decisionGatewayToolNames(selection, { connected = true } = {}) {
  if (selection === 'direct_answer') return [];
  // Context is an authenticated read, not a direct answer.  Keep this
  // mapping beside every other HIVE read so a JEV decision never exposes an
  // empty surface and leaves the synthesis model unable to obtain evidence.
  if (['hivemind_context', 'hivemind_meta', 'hivemind_memory_lookup', 'hivemind_entity_lookup', 'hivemind_hyperagent_directory', 'hivemind_request'].includes(selection)) return ['hivemind_meta'];
  if (selection === 'hivemind_profile_update') return ['hivemind_update_profile'];
  // The unified graph exposes HIVEMIND through its one typed meta gateway;
  // operation="save" is constrained further by the selected executor prompt.
  if (selection === 'hivemind_save') return ['hivemind_meta'];
  if (['composio_search', 'composio_read', 'composio_action'].includes(selection) && connected) return ['hivemind_connected_task'];
  if (selection === 'web_research') return ['hivemind_web_search'];
  // Multi-domain requests stay on the native surface. Subsequent JEV stages
  // constrain each provider-backed operation after evidence is available.
  if (selection === 'multi_task' || selection === 'workflow_plan') return undefined;
  // A failed/uncertain decision is recorded as fallback_harness, but it must
  // not silently regain the entire native tool surface and re-plan itself.
  if (selection === 'fallback_harness') return [];
  return [];
}

/**
 * Run one bounded decision without executing a tool or changing state.
 * The caller remains authoritative for fallback, authorization, arguments,
 * approval, and execution.
 */
export async function decideRuntimeStage(input = {}, {
  env = process.env,
  provider = null,
  signal = null,
} = {}) {
  const mode = modeFromEnv(env);
  const stage = boundedString(input.stage, 80);
  const runtime = input.runtime === 'harness' ? 'harness' : 'legacy';
  if (mode === 'off') return { status: 'defer', mode, stage: stage || null, reason: 'decision_gateway_off' };
  const allowlist = actorAllowlist(env);
  const actorId = boundedString(input.actor_id, 128).toLowerCase();
  if (allowlist.size > 0 && (!actorId || !allowlist.has(actorId))) {
    return { status: 'defer', mode, stage: stage || null, reason: 'decision_gateway_actor_not_allowed' };
  }
  if (allowlist.size === 0 && String(env.JEV_DECISION_GATEWAY_ALLOW_ALL || '').toLowerCase() !== 'true') {
    return { status: 'defer', mode, stage: stage || null, reason: 'decision_gateway_allowlist_required' };
  }
  if (!VALID_STAGES.has(stage)) return { status: 'defer', mode, stage: stage || null, reason: 'decision_stage_invalid' };

  const userQuery = boundedString(input.user_query, 4000);
  if (!userQuery) return { status: 'defer', mode, stage, reason: 'decision_query_required' };

  const providerConfig = decisionGatewayProviderConfig(env);
  // Post-receipt workflow transitions choose among a small, already-governed
  // set of next operations. Their selection cannot execute a write: schema,
  // explicit scope, approval, idempotency, and receipts remain graph-owned.
  // A global 0.80 threshold is appropriate for initial admission but rejects
  // useful calibrated choices in this narrower multi-outcome stage.
  const workflowTransition = stage === 'workflow_transition';
  const memoryType = stage === 'memory_type';
  const minProbability = finiteThreshold(
    workflowTransition ? env.JEV_WORKFLOW_MIN_PROBABILITY : (memoryType ? env.JEV_MEMORY_TYPE_MIN_PROBABILITY : env.JEV_MIN_PROBABILITY),
    workflowTransition ? 0.5 : (memoryType ? 0.65 : 0.8),
  );
  const minMargin = finiteThreshold(
    workflowTransition ? env.JEV_WORKFLOW_MIN_MARGIN : (memoryType ? env.JEV_MEMORY_TYPE_MIN_MARGIN : env.JEV_MIN_MARGIN),
    workflowTransition ? 0.05 : (memoryType ? 0.1 : 0.2),
  );
  const gateway = new DecisionGateway({
    provider: provider || createOpenRouterJevProvider({
      apiKey: providerConfig.apiKey,
      endpoint: providerConfig.endpoint,
      headers: providerConfig.headers,
      model: providerConfig.model,
      timeoutMs: Number(env.JEV_TIMEOUT_MS || 3500),
    }),
    minProbability,
    minMargin,
  });
  const turn = createDecisionTurnState(input.turn_id ?? null);
  const fallback = async ({ reason }) => fallbackReceipt(reason);
  const common = {
    gateway,
    turn,
    userQuery,
    context: input.context || null,
    observation: input.observation || null,
    fallback,
    signal,
  };

  let receipt;
  if (stage === 'capability') {
    receipt = await chooseCapability({
      ...common,
      appMentions: Array.isArray(input.app_mentions) ? input.app_mentions.slice(0, 12) : [],
      operationalAppIntent: input.operational_app_intent === true,
    });
  } else if (stage === 'composio_selection') {
    receipt = await chooseComposioAction({
      ...common,
      discovery: input.discovery || {},
      progress: input.progress || null,
    });
  } else if (stage === 'composio_argument_review') {
    receipt = await chooseComposioArgumentReview({
      ...common,
      selectedTool: input.selected_tool || input.selectedTool || null,
      proposedArguments: input.proposed_arguments || input.proposedArguments || {},
      progress: input.progress || null,
    });
  } else if (stage === 'workflow_transition') {
    receipt = await chooseWorkflowTransition(common);
  } else if (stage === 'memory_type') {
    receipt = await chooseMemoryType(common);
  } else if (stage === 'hivemind_meta_selection') {
    receipt = await chooseHiveMetaOperation(common);
  } else {
    receipt = await chooseHiveRecallPolicy(common);
    if (receipt.source === 'jev') receipt = { ...receipt, translated: translateRecallPolicy(receipt.policy, runtime === 'harness' ? 'harness' : 'core') };
  }

  const accepted = receipt.source === 'jev' || receipt.source === 'deterministic';
  const selected = accepted ? receipt.choice || null : null;
  return {
    status: mode === 'active' && accepted ? 'selected' : 'defer',
    mode,
    stage,
    selected,
    authoritative: mode === 'active' && accepted,
    receipt,
  };
}

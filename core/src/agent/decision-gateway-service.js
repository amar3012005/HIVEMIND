import {
  DecisionGateway,
  chooseCapability,
  chooseComposioAction,
  chooseHiveMetaOperation,
  chooseHiveRecallPolicy,
  createDecisionTurnState,
  createOpenRouterJevProvider,
  translateRecallPolicy,
} from './decision-gateway.js';

const VALID_MODES = new Set(['off', 'shadow', 'active']);
const VALID_STAGES = new Set(['capability', 'composio_selection', 'hivemind_meta_selection', 'hivemind_recall_filters']);

function modeFromEnv(env) {
  const mode = String(env.JEV_DECISION_GATEWAY_MODE || 'off').trim().toLowerCase();
  return VALID_MODES.has(mode) ? mode : 'off';
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
  if (selection === 'direct_answer' || selection === 'hivemind_context') return [];
  if (selection === 'hivemind_meta' || selection === 'hivemind_save') return ['hivemind_meta'];
  if (selection === 'composio_search' && connected) return ['hivemind_connected_task'];
  return null;
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
  if (!VALID_STAGES.has(stage)) return { status: 'defer', mode, stage: stage || null, reason: 'decision_stage_invalid' };

  const userQuery = boundedString(input.user_query, 4000);
  if (!userQuery) return { status: 'defer', mode, stage, reason: 'decision_query_required' };

  const gateway = new DecisionGateway({
    provider: provider || createOpenRouterJevProvider({
      apiKey: env.OPENROUTER_API_KEY,
      endpoint: env.JEV_DECISIONS_URL,
      model: env.JEV_MODEL,
      timeoutMs: Number(env.JEV_TIMEOUT_MS || 3500),
    }),
    minProbability: finiteThreshold(env.JEV_MIN_PROBABILITY, 0.8),
    minMargin: finiteThreshold(env.JEV_MIN_MARGIN, 0.2),
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

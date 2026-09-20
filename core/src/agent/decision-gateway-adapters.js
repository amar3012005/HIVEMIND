import {
  chooseCapability,
  chooseComposioAction,
  chooseHiveMetaOperation,
  chooseHiveRecallPolicy,
  createDecisionTurnState,
  translateRecallPolicy,
} from './decision-gateway.js';

const STAGES = Object.freeze({
  capability: 'capability',
  composio: 'composio_selection',
  hiveMeta: 'hivemind_meta_selection',
  hiveRecall: 'hivemind_recall_filters',
});

/**
 * Thin runtime adapter. It owns no planning or execution; it binds the shared
 * gateway to the runtime's existing selectors and keeps one circuit breaker
 * for the complete turn.
 */
export function createDecisionRuntimeAdapter({ runtime, gateway, turnId = null, fallbacks = {} } = {}) {
  if (!['harness', 'legacy'].includes(runtime)) throw new TypeError('decision_runtime_must_be_harness_or_legacy');
  if (!gateway) throw new TypeError('decision_gateway_required');
  const turn = createDecisionTurnState(turnId);
  const fallbackFor = key => {
    const fallback = fallbacks[key] || fallbacks.default;
    if (typeof fallback !== 'function') throw new TypeError(`decision_${key}_fallback_required`);
    return fallback;
  };
  return {
    runtime,
    turn,
    async capability(input) {
      return chooseCapability({ gateway, turn, ...input, fallback: fallbackFor(STAGES.capability) });
    },
    async composio(input) {
      return chooseComposioAction({ gateway, turn, ...input, fallback: fallbackFor(STAGES.composio) });
    },
    async hiveMeta(input) {
      return chooseHiveMetaOperation({ gateway, turn, ...input, fallback: fallbackFor(STAGES.hiveMeta) });
    },
    async hiveRecall(input) {
      const result = await chooseHiveRecallPolicy({ gateway, turn, ...input, fallback: fallbackFor(STAGES.hiveRecall) });
      return result.source === 'jev' ? { ...result, translated: translateRecallPolicy(result.policy, runtime === 'harness' ? 'harness' : 'core') } : result;
    },
  };
}

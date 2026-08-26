import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { planNativeTurn } from './planner.js';
import { validateNativePlanResult } from './plan-validator.js';
import { compileNativePlan } from './plan-compiler.js';
import { buildTurnContext } from './turn-context-builder.js';
import { compactCapabilityCatalog } from './capability-registry.js';
import { hydrateCompactContext } from './compact-context.js';

const State = Annotation.Root({
  input: Annotation(), context: Annotation(), capabilityCatalog: Annotation(), rawPlan: Annotation(),
  validation: Annotation(), validatedPlan: Annotation(), decision: Annotation(), usage: Annotation(),
});

export function createNativePlannerGraph({ planner = planNativeTurn, compactContextGraph } = {}) {
  return new StateGraph(State)
    .addNode('turn_context', async (state) => {
      const compact = await hydrateCompactContext(state.input, { graph: compactContextGraph });
      return { context: buildTurnContext({ ...state.input, history: compact.history, recentSourceRefs: compact.sourceRefs }) };
    })
    .addNode('capability_catalog', async () => ({ capabilityCatalog: compactCapabilityCatalog() }))
    .addNode('semantic_planner', async (state) => {
      const result = await planner({ ...state.input, context: state.context, capabilityCatalog: state.capabilityCatalog });
      return { rawPlan: result.rawPlan, usage: result.usage };
    })
    .addNode('validate_plan', async (state) => {
      const validation = validateNativePlanResult(state.rawPlan);
      if (validation.status === 'invalid') throw new Error(validation.error);
      return { validation, validatedPlan: validation.plan };
    })
    .addNode('compile_plan', async (state) => ({ decision: compileNativePlan(state.validatedPlan, state.input.message, state.context) }))
    .addEdge(START, 'turn_context')
    .addEdge('turn_context', 'capability_catalog')
    .addEdge('capability_catalog', 'semantic_planner')
    .addEdge('semantic_planner', 'validate_plan')
    .addEdge('validate_plan', 'compile_plan')
    .addEdge('compile_plan', END)
    .compile();
}

export async function parseNativeTurnV2(input, dependencies = {}) {
  const result = await createNativePlannerGraph(dependencies).invoke({ input });
  return { decision: result.decision, usage: result.usage, plan: result.validatedPlan, validation: result.validation };
}

function stableBucket(seed = '') {
  let hash = 2166136261;
  for (const char of String(seed)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 100;
}

export function nativeV2RoutingMode({ useTools, seed } = {}) {
  if (useTools === true) return 'off';
  if (process.env.CHAT_ORCHESTRATOR_V2_ENABLED === 'true') return 'serve';
  const percent = Math.max(0, Math.min(100, Number(process.env.CHAT_ORCHESTRATOR_V2_CANARY_PERCENT || 0)));
  if (percent > 0 && stableBucket(seed) < percent) return 'serve';
  if (process.env.CHAT_ORCHESTRATOR_V2_SHADOW === 'true') return 'shadow';
  return 'off';
}

export function nativeV2Eligible(input = {}) {
  return nativeV2RoutingMode(input) === 'serve';
}

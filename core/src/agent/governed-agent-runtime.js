import crypto from 'node:crypto';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { createPostgresCheckpointer } from '../hq-runtime/langgraph/postgres-checkpointer.js';
import { runDurableComposioAgent } from './durable-composio-agent.js';

const GovernedState = Annotation.Root({
  request: Annotation({ reducer: (_left, right) => right, default: () => null }),
  result: Annotation({ reducer: (_left, right) => right, default: () => null }),
  humanChoice: Annotation({ reducer: (_left, right) => right, default: () => null }),
  status: Annotation({ reducer: (_left, right) => right, default: () => 'received' }),
});

export function assertLangSmithRedaction(env = process.env) {
  if (String(env.LANGSMITH_TRACING || '').toLowerCase() !== 'true') return true;
  if (String(env.LANGSMITH_HIDE_INPUTS || '').toLowerCase() !== 'true'
    || String(env.LANGSMITH_HIDE_OUTPUTS || '').toLowerCase() !== 'true') {
    throw new Error('langsmith_redaction_required');
  }
  return true;
}

export function governedGraphThreadId({ ctx = {}, message = '' } = {}) {
  const latched = String(ctx.governedGraphThreadId || '').trim();
  if (latched) return latched;
  const identity = [ctx.orgId, ctx.userId, ctx.durableChatTurnId || ctx.threadId || ctx.conversationId || '', message]
    .map(value => String(value || '')).join('\u0000');
  return `governed:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 40)}:v1`;
}

export function createGovernedAgentGraph({ checkpointer, execute = runDurableComposioAgent, projectResult = value => value } = {}) {
  const executeNode = async state => {
    const result = await execute({ choice: state.humanChoice || null });
    return { result: projectResult(result), humanChoice: null, status: result.status === 'needs_input' ? 'awaiting_human' : result.status };
  };
  const humanNode = async state => {
    const result = state.result || {};
    const choice = interrupt({
      run_id: result.run?.id || result.run_id || null,
      reason: result.run?.status || result.run_status || 'awaiting_input',
    });
    return { humanChoice: choice, status: 'resumed' };
  };
  return new StateGraph(GovernedState)
    .addNode('execute', executeNode)
    .addNode('await_human', humanNode)
    .addEdge(START, 'execute')
    .addConditionalEdges('execute', state => state.result?.status === 'needs_input' ? 'await_human' : END)
    .addEdge('await_human', 'execute')
    .compile(checkpointer ? { checkpointer } : {});
}

let productionCheckpointerPromise;
async function productionCheckpointer() {
  if (!productionCheckpointerPromise) {
    productionCheckpointerPromise = createPostgresCheckpointer({
      connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
      schema: 'hivemind_governed_agent_langgraph',
    }).then(handle => handle.checkpointer)
      .catch(error => { productionCheckpointerPromise = null; throw error; });
  }
  return productionCheckpointerPromise;
}

function withGraphResume(result, threadId) {
  if (!result || result.status !== 'needs_input') return result;
  return {
    ...result,
    resumeState: {
      ...(result.resumeState || {}),
      kind: 'governed_langgraph',
      graph_thread_id: threadId,
    },
  };
}

export async function runGovernedAgentRuntime({ message, ctx = {}, onEvent, composio = null, prisma = null, choice = null, graph = null } = {}) {
  assertLangSmithRedaction();
  const threadId = governedGraphThreadId({ ctx, message });
  const baseChoice = choice || ctx.durableChoice || null;
  let lastResult = null;
  const execute = async ({ choice: graphChoice } = {}) => {
    onEvent?.({ type: 'agent_state', state: graphChoice || baseChoice ? 'resumed' : 'context_loaded', run_id: null });
    const result = await runDurableComposioAgent({
      message,
      ctx: { ...ctx, governedGraphThreadId: threadId, durableChoice: graphChoice || baseChoice },
      onEvent,
      composio,
      prisma,
      choice: graphChoice || baseChoice,
    });
    onEvent?.({ type: 'agent_state', state: result.run?.status || result.status, run_id: result.run?.id || null });
    lastResult = result;
    return result;
  };
  const runtime = graph || createGovernedAgentGraph({
    checkpointer: await productionCheckpointer(),
    execute,
    // LangSmith sees graph transitions and redacted metadata, never message,
    // connector arguments, mailbox bodies, OAuth state, or provider results.
    projectResult: result => ({
      status: result.status,
      run_id: result.run?.id || null,
      run_status: result.run?.status || null,
      step_count: Array.isArray(result.steps) ? result.steps.length : 0,
      receipt_count: Array.isArray(result.run?.scratch?.read_results) ? result.run.scratch.read_results.length : 0,
      draft_count: Array.isArray(result.draftIds) ? result.draftIds.length : 0,
    }),
  });
  const config = {
    configurable: { thread_id: threadId },
    metadata: {
      runtime: 'governed-agent-v1',
      org_hash: crypto.createHash('sha256').update(String(ctx.orgId || '')).digest('hex').slice(0, 16),
      user_hash: crypto.createHash('sha256').update(String(ctx.userId || '')).digest('hex').slice(0, 16),
      locale: String(ctx.language || 'en').slice(0, 12),
    },
    tags: ['governed-agent-v1'],
  };
  const output = baseChoice
    ? await runtime.invoke(new Command({ resume: baseChoice }), config)
    : await runtime.invoke({ status: 'received' }, config);
  return withGraphResume(lastResult || output.result, threadId);
}

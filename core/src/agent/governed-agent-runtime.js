import crypto from 'node:crypto';
import { Command } from '@langchain/langgraph';
import { createPostgresCheckpointer } from '../hq-runtime/langgraph/postgres-checkpointer.js';
import { createGovernedKernel } from './governed-agent-kernel.js';

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
  return `governed:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 40)}:native-v1`;
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

function interruptedResult(output, threadId) {
  const payload = output?.__interrupt__?.[0]?.value || {};
  const fields = Array.isArray(payload.fields) ? payload.fields : [];
  const request = {
    ...payload,
    kind: payload.kind || 'field_input',
    prompt: payload.prompt || 'What information should I use?',
    fields,
    step_index: 0,
    step_id: 'langgraph-input',
  };
  return {
    status: 'needs_input',
    summary: request.prompt,
    response: request.prompt,
    run: { id: payload.run_id || output?.runId || null, status: 'awaiting_input', composioSessionId: output?.sessionId || null,
      scratch: { harness_version: 'langgraph-native-v1', read_results: output?.receipts || [] } },
    steps: output?.steps || [],
    draftIds: [],
    pendingActions: [],
    inputRequests: [request],
    resumeState: { kind: 'governed_langgraph', graph_thread_id: threadId, run_id: payload.run_id || output?.runId || null,
      results: [{ inputRequest: request }] },
  };
}

export async function runGovernedAgentRuntime({ message, ctx = {}, onEvent, composio = null, prisma = null, choice = null, graph = null } = {}) {
  assertLangSmithRedaction();
  const threadId = governedGraphThreadId({ ctx, message });
  const baseChoice = choice || ctx.durableChoice || null;
  const db = prisma || ctx.prisma;
  if (!db) throw new Error('governed_prisma_required');
  const connector = composio || await import('../connectors/composio/composio-service.js');
  const runtimeCtx = { ...ctx, governedGraphThreadId: threadId };
  const runtime = graph || createGovernedKernel({ checkpointer: await productionCheckpointer(), ctx: runtimeCtx, message, onEvent, composio: connector, prisma: db });
  const config = {
    configurable: { thread_id: threadId },
    recursionLimit: 64,
    metadata: {
      runtime: 'langgraph-native-v1',
      org_hash: crypto.createHash('sha256').update(String(ctx.orgId || '')).digest('hex').slice(0, 16),
      user_hash: crypto.createHash('sha256').update(String(ctx.userId || '')).digest('hex').slice(0, 16),
      locale: String(ctx.language || 'en').slice(0, 12),
    },
    tags: ['langgraph-native-v1'],
  };
  const output = baseChoice
    ? await runtime.invoke(new Command({ resume: baseChoice }), config)
    : await runtime.invoke({ status: 'received' }, config);
  if (output?.__interrupt__?.length) {
    const payload = output.__interrupt__[0]?.value || {};
    if (payload.kind === 'approval' && output.result) return { ...output.result, resumeState: null };
    return interruptedResult(output, threadId);
  }
  return withGraphResume(output?.result, threadId);
}

export async function resumeGovernedApproval({ row, action, ctx, onEvent, prisma } = {}) {
  const threadId = row?.toolArgs?._graph_thread_id;
  if (!threadId || row?.toolArgs?._harness_version !== 'langgraph-native-v1') throw new Error('governed_approval_checkpoint_missing');
  const run = await prisma.agentRun.findFirst({ where: { id: row.traceId, orgId: ctx.orgId, userId: ctx.userId } });
  if (!run) throw new Error('governed_approval_run_missing');
  return runGovernedAgentRuntime({ message: run.goal, ctx: { ...ctx, governedGraphThreadId: threadId }, onEvent, prisma,
    choice: { action: action === 'cancel' ? 'reject' : 'approve', approval_id: row.id } });
}

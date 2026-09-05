import crypto from 'node:crypto';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { createPostgresCheckpointer } from '../hq-runtime/langgraph/postgres-checkpointer.js';
import { createGovernedKernel } from './governed-agent-kernel.js';
import { GovernedAgentEventLedger, safeEventEnvelope } from './governed-agent-event-ledger.js';

export const GOVERNED_HARNESS_VERSION = 'langgraph-native-v1';

export function isGovernedHarnessVersion(value) {
  return String(value || '') === GOVERNED_HARNESS_VERSION;
}

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

export function governedRunId(ctx = {}) {
  return String(ctx.governedRunId || '').trim() || crypto.randomUUID();
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
  const approval = request.kind === 'approval';
  const providerWait = request.kind === 'provider_event';
  const interruptedStatus = approval ? 'awaiting_approval' : (providerWait ? 'awaiting_provider_event' : 'awaiting_input');
  const priorRun = output?.result?.run || {};
  return {
    status: approval || providerWait ? 'pending' : 'needs_input',
    summary: approval ? output?.result?.summary || 'Draft ready for approval. Nothing has been sent.' : request.prompt,
    response: approval ? output?.result?.response || 'Draft ready for approval. Nothing has been sent.' : request.prompt,
    // The draft result was persisted before LangGraph raised the interrupt.
    // Its snapshot can therefore still say `awaiting_approval`; expose the
    // actual interrupt state to the durable-turn/SSE callers instead.
    run: {
      ...priorRun,
      id: payload.run_id || output?.runId || null,
      status: interruptedStatus,
      composioSessionId: priorRun.composioSessionId || output?.sessionId || null,
      scratch: {
        ...(priorRun.scratch || {}),
        harness_version: GOVERNED_HARNESS_VERSION,
        read_results: priorRun.scratch?.read_results || output?.receipts || [],
      },
    },
    steps: output?.result?.steps || output?.steps || [],
    draftIds: output?.result?.draftIds || (payload.approval_id ? [payload.approval_id] : []),
    pendingActions: output?.result?.pendingActions || (payload.approval_id ? [{ id: payload.approval_id }] : []),
    inputRequests: approval || providerWait ? [] : [request],
    resumeState: {
      kind: 'governed_langgraph',
      graph_thread_id: threadId,
      run_id: payload.run_id || output?.runId || null,
      results: approval || providerWait ? [] : [{ inputRequest: request }],
    },
  };
}

function failureCode(error) {
  const raw = String(error?.code || error?.message || 'governed_runtime_failed');
  return raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'governed_runtime_failed';
}

async function persistRuntimeFailure({ db, ctx, runId, onEvent, error }) {
  if (!db?.agentRun?.findFirst || !db?.agentRun?.update || !runId) return;
  const run = await db.agentRun.findFirst({ where: { id: runId, orgId: ctx.orgId, userId: ctx.userId } }).catch(() => null);
  if (!run) return;
  const sequence = Math.max(1, Number(run.scratch?.event_sequence || 0) + 1);
  const ledger = new GovernedAgentEventLedger({ prisma: db });
  const appended = await ledger.append({
    orgId: ctx.orgId,
    userId: ctx.userId,
    runId,
    sequence,
    type: 'state_transition',
    payload: { state: 'failed', reason_code: failureCode(error), input_fields: [] },
  }).catch(() => ({ event: null }));
  await db.agentRun.update({
    where: { id: runId },
    data: {
      status: 'failed',
      scratch: { ...(run.scratch || {}), event_sequence: sequence, failure_code: failureCode(error) },
    },
  }).catch(() => {});
  const event = safeEventEnvelope({ event: appended.event, runId, state: 'failed', sequence });
  onEvent?.({ type: 'agent_state', state: 'failed', ...event });
}

/**
 * Production entrypoint.  A turn's graph thread and run IDs are latched at
 * admission; all later human, OAuth, approval, and provider-event resumes use
 * Command.resume on this same checkpoint.
 */
export async function runGovernedAgentRuntime({
  message,
  ctx = {},
  onEvent,
  composio = null,
  prisma = null,
  choice = null,
  graph = null,
  checkpointer = null,
  traceClient = null,
} = {}) {
  assertLangSmithRedaction();
  const baseChoice = choice || ctx.durableChoice || null;
  const threadId = governedGraphThreadId({ ctx, message });
  const runId = governedRunId({ ...ctx, governedRunId: ctx.governedRunId || baseChoice?.run_id || null });
  const db = prisma || ctx.prisma;
  if (!db) throw new Error('governed_prisma_required');
  const connector = composio || await import('../connectors/composio/composio-service.js');
  const runtimeCtx = { ...ctx, governedGraphThreadId: threadId, governedRunId: runId };
  const runtime = graph || createGovernedKernel({
    checkpointer: checkpointer || await productionCheckpointer(),
    ctx: runtimeCtx,
    message,
    onEvent,
    composio: connector,
    prisma: db,
    traceClient,
  });
  const config = {
    configurable: { thread_id: threadId },
    recursionLimit: 64,
    metadata: {
      runtime: GOVERNED_HARNESS_VERSION,
      org_hash: crypto.createHash('sha256').update(String(ctx.orgId || '')).digest('hex').slice(0, 16),
      user_hash: crypto.createHash('sha256').update(String(ctx.userId || '')).digest('hex').slice(0, 16),
      locale: String(ctx.language || 'en').slice(0, 12),
    },
    tags: [GOVERNED_HARNESS_VERSION],
  };
  try {
    const output = baseChoice
      ? await runtime.invoke(new Command({ resume: baseChoice }), config)
      : await runtime.invoke({ runId, status: 'received', event: ctx.governedEvent || null }, config);
    if (output?.__interrupt__?.length) return interruptedResult(output, threadId);
    return output?.result || {
      status: 'error',
      summary: 'The governed run ended without a result.',
      response: 'The governed run ended without a result.',
      run: { id: runId, status: 'failed', scratch: { harness_version: GOVERNED_HARNESS_VERSION } },
      steps: output?.steps || [],
      draftIds: [],
      pendingActions: [],
      resumeState: null,
    };
  } catch (error) {
    await persistRuntimeFailure({ db, ctx, runId, onEvent, error });
    return {
      status: 'error',
      summary: 'I could not complete this connected task. Completed evidence is retained.',
      response: 'I could not complete this connected task. Completed evidence is retained.',
      run: { id: runId, status: 'failed', scratch: { harness_version: GOVERNED_HARNESS_VERSION, failure_code: failureCode(error) } },
      steps: [],
      draftIds: [],
      pendingActions: [],
      resumeState: null,
    };
  }
}

export async function resumeGovernedApproval({ row, action, ctx, onEvent, prisma } = {}) {
  const threadId = row?.toolArgs?._graph_thread_id;
  if (!threadId || !isGovernedHarnessVersion(row?.toolArgs?._harness_version)) throw new Error('governed_approval_checkpoint_missing');
  const run = await prisma.agentRun.findFirst({ where: { id: row.traceId, orgId: ctx.orgId, userId: ctx.userId } });
  if (!run) throw new Error('governed_approval_run_missing');
  return runGovernedAgentRuntime({
    message: run.goal,
    ctx: { ...ctx, governedGraphThreadId: threadId, governedRunId: run.id },
    onEvent,
    prisma,
    choice: { action: action === 'cancel' ? 'reject' : 'approve', approval_id: row.id },
  });
}

/**
 * Ingest a sanitized provider callback exactly once, then resume a graph that
 * is explicitly waiting for a provider event.  Callers retain raw payloads in
 * their provider-specific receipt store; the generic ledger records only the
 * event envelope and schema keys.
 */
export async function resumeGovernedProviderEvent({
  ctx = {},
  runId,
  provider,
  eventId,
  eventType,
  outcome = 'unknown',
  payload = {},
  prisma,
  onEvent,
  checkpointer = null,
} = {}) {
  const db = prisma || ctx.prisma;
  if (!db || !runId || !eventId || !provider) throw new Error('governed_provider_event_scope_required');
  const ledger = new GovernedAgentEventLedger({ prisma: db });
  const accepted = await ledger.receiveProviderEvent({
    orgId: ctx.orgId,
    userId: ctx.userId,
    runId,
    eventId,
    provider,
    eventType,
    payload,
  });
  if (accepted.duplicate) return { duplicate: true, status: 'duplicate', event: accepted.event };
  const run = await db.agentRun.findFirst({ where: { id: runId, orgId: ctx.orgId, userId: ctx.userId } });
  if (!run) throw new Error('governed_provider_event_run_not_found');
  if (run.status !== 'awaiting_provider_event') {
    return { duplicate: false, ignored: true, status: 'not_waiting_for_provider_event', event: accepted.event };
  }
  const threadId = String(run.scratch?.graph_thread_id || '').trim();
  if (!threadId) throw new Error('governed_provider_event_checkpoint_missing');
  const result = await runGovernedAgentRuntime({
    message: run.goal,
    ctx: {
      ...ctx,
      governedGraphThreadId: threadId,
      governedRunId: run.id,
      governedEvent: accepted.event,
    },
    onEvent,
    prisma: db,
    checkpointer,
    choice: { type: 'provider_event', event_id: eventId, provider, event_type: eventType, outcome },
  });
  return { duplicate: false, status: result.status, result, event: accepted.event };
}

/* Minimal test-only graph constructor. It exercises LangGraph's durable
 * interrupt semantics independently of Composio and never participates in
 * production routing. */
export function createGovernedAgentGraph({ checkpointer, execute }) {
  const State = Annotation.Root({ request: Annotation, pending: Annotation, choice: Annotation, result: Annotation });
  const begin = async state => {
    const result = await execute({ request: state.request, choice: null });
    return result?.status === 'needs_input' ? { pending: result, result } : { result };
  };
  const wait = async state => ({ choice: interrupt({ ...(state.pending?.inputRequests?.[0] || {}), run_id: state.pending?.run?.id }) });
  const finish = async state => ({ result: await execute({ request: state.request, choice: state.choice }) });
  const routeBegin = state => state.pending?.status === 'needs_input' ? 'wait' : END;
  return new StateGraph(State)
    .addNode('begin', begin)
    .addNode('wait', wait)
    .addNode('finish', finish)
    .addEdge(START, 'begin')
    .addConditionalEdges('begin', routeBegin, ['wait', END])
    .addEdge('wait', 'finish')
    .addEdge('finish', END)
    .compile({ checkpointer });
}

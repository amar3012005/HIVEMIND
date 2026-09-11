import crypto from 'node:crypto';
import Ajv from 'ajv';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { chatCompletionFetch, resolveChatSynthesisModel } from '../llm/chat-provider.js';
import { createPostgresCheckpointer } from '../hq-runtime/langgraph/postgres-checkpointer.js';
import { getSharedProfileStore } from '../memory/profile-store.js';
import { executeGovernedCoreRead, executeGovernedCoreWrite } from './governed-agent-core-tools.js';
import { ORGANIZATIONAL_BRAIN_PERSONA } from './chat-persona-skill.js';
import { projectGovernedEvidence } from './governed-evidence-projection.js';
import { GovernedAgentEventLedger, safeEventEnvelope } from './governed-agent-event-ledger.js';
import {
  compactConnectedSearch,
  connectedToolAuthority,
  disconnectedToolkits,
  parseUnifiedToolCall,
  unifiedMetaTools,
} from './unified-meta-tool-contract.js';

export const UNIFIED_META_HARNESS_VERSION = 'langgraph-meta-loop-v2';
const MAX_STEPS = 12;

const State = Annotation.Root({
  runId: Annotation({ reducer: (_left, right) => right, default: () => null }),
  context: Annotation({ reducer: (_left, right) => right, default: () => null }),
  messages: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  receipts: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  steps: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  pendingTool: Annotation({ reducer: (_left, right) => right, default: () => null }),
  pendingConnection: Annotation({ reducer: (_left, right) => right, default: () => null }),
  pendingApproval: Annotation({ reducer: (_left, right) => right, default: () => null }),
  selectedSlugs: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  schemas: Annotation({ reducer: (_left, right) => right, default: () => ({}) }),
  sessionId: Annotation({ reducer: (_left, right) => right, default: () => null }),
  workflowSessionId: Annotation({ reducer: (_left, right) => right, default: () => null }),
  cycles: Annotation({ reducer: (_left, right) => right, default: () => 0 }),
  repairs: Annotation({ reducer: (_left, right) => right, default: () => 0 }),
  callFingerprints: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  result: Annotation({ reducer: (_left, right) => right, default: () => null }),
  usage: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  status: Annotation({ reducer: (_left, right) => right, default: () => 'received' }),
  eventSequence: Annotation({ reducer: (_left, right) => right, default: () => 0 }),
});

const compactText = (value, limit = 1800) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
// Final assistant Markdown is a UI contract. Never normalize its whitespace:
// doing so destroys GFM tables, lists, code fences, and paragraph boundaries.
const markdownText = (value, limit = 24000) => String(value ?? '').trim().slice(0, limit);
const jsonText = value => JSON.stringify(value ?? null);

function localized(locale, key, toolkit = '') {
  const language = String(locale || 'en').toLowerCase().split(/[-_]/)[0];
  const messages = {
    en: { connect: `Connect ${toolkit} to continue, then return here.`, retry: `I've connected ${toolkit} — continue`, waiting: `The ${toolkit} connection is not active yet. Complete authorization, then continue.`, approval: 'Review this draft. Approve to execute it once, or reject it.' },
    de: { connect: `Verbinde ${toolkit}, um fortzufahren, und kehre dann hierher zurück.`, retry: `${toolkit} ist verbunden — fortfahren`, waiting: `Die ${toolkit}-Verbindung ist noch nicht aktiv. Schließe die Autorisierung ab und fahre dann fort.`, approval: 'Prüfe diesen Entwurf. Genehmige ihn für eine einmalige Ausführung oder lehne ihn ab.' },
    fr: { connect: `Connectez ${toolkit} pour continuer, puis revenez ici.`, retry: `${toolkit} est connecté — continuer`, waiting: `La connexion ${toolkit} n’est pas encore active. Terminez l’autorisation, puis continuez.`, approval: 'Vérifiez ce brouillon. Approuvez son exécution unique ou refusez-le.' },
    es: { connect: `Conecta ${toolkit} para continuar y vuelve aquí.`, retry: `${toolkit} está conectado — continuar`, waiting: `La conexión de ${toolkit} aún no está activa. Completa la autorización y continúa.`, approval: 'Revisa este borrador. Apruébalo para ejecutarlo una vez o recházalo.' },
  };
  return (messages[language] || messages.en)[key];
}

function systemPrompt({ useTools, locale }) {
  return `${ORGANIZATIONAL_BRAIN_PERSONA}

You have ${useTools ? 'two' : 'one'} stable progressive gateway tools: hivemind_meta${useTools ? ' and hivemind_connected_task' : ''}. Use recent conversation and the compact authenticated profile when sufficient. Use hivemind_meta only when organization memory, documents, history, a profile, or a durable save is needed. For external apps, search once with complete atomic use cases, follow the returned connection state and selected slugs, load only selected schemas, then execute through the same gateway.

Continue after every tool receipt as the same agent. If evidence is incomplete, make the next useful gateway call. Ask the user only for a real business choice that cannot be discovered. Never ask for provider IDs. Never claim that an approval draft was executed. Answer in ${locale || 'the user language'} with concise, well-structured Markdown. Use tables when the user requests multiple records and preserve evidence citations.`;
}

function safeHistory(history = [], limit = 3) {
  return (Array.isArray(history) ? history : []).filter(row => ['user', 'assistant'].includes(row?.role) && row?.content)
    .slice(-limit * 2).map(row => ({ role: row.role, content: compactText(row.content, 1400) }));
}

function publicToolResult(value) {
  if (value?.successful === false) return { successful: false, error: compactText(value.error || 'operation_failed', 400) };
  return projectGovernedEvidence(value?.data ?? value, 24000);
}

function resultSources(receipts = []) {
  const output = [];
  const seen = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    const title = value.title || value.source_title || value.filename || value.document_title;
    const id = value.id || value.memory_id || value.document_id || null;
    if (title && !seen.has(`${id || ''}:${title}`)) {
      seen.add(`${id || ''}:${title}`);
      output.push({ id, title: String(title), type: value.source_type || value.kind || 'evidence' });
    }
    for (const [key, nested] of Object.entries(value)) {
      if (['content', 'body', 'text', 'snippet'].includes(key)) continue;
      visit(nested);
    }
  };
  receipts.filter(row => row.successful !== false).forEach(row => visit(row.data));
  return output.slice(0, 12);
}

function invalidFinal(text, receipts) {
  const answer = markdownText(text, 24000);
  if (!answer || /\[object Object\]/.test(answer)) return true;
  if (!(receipts || []).some(row => row.successful !== false && row.data != null)) return false;
  return /(?:i can(?:not|'t) directly display|i can only confirm|i can show you(?:\.|$)|cannot retrieve the other)/i.test(answer);
}

async function defaultModelStep({ messages, tools, model, apiKey, signal }) {
  const response = await chatCompletionFetch(resolveChatSynthesisModel(model), {
    method: 'POST', signal,
    body: JSON.stringify({ temperature: 0, max_tokens: 2400, tools, tool_choice: 'auto', messages }),
  }, { fallbackApiKey: apiKey, useCase: 'chat', traceId: crypto.randomUUID() });
  if (!response.ok) throw new Error(`unified_model_http_${response.status}`);
  const payload = await response.json();
  const message = payload?.choices?.[0]?.message;
  if (!message || (!compactText(message.content) && !message.tool_calls?.length)) throw new Error('unified_model_empty_choice');
  return { message, usage: payload.usage || null };
}

function recallArgs(input = {}, ctx = {}) {
  return {
    query: input.query,
    mode: input.mode || 'fact',
    limit: input.limit || 5,
    ...(input.project ? { project: input.project } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
    ...(input.source_title ? { source_title: input.source_title } : {}),
    ...(input.valid_at ? { valid_at: input.valid_at } : {}),
    ...(input.transaction_at ? { known_at: input.transaction_at } : {}),
    ...(input.sort ? { sort: input.sort } : {}),
    ...(ctx.scopeFilter ? { scope_filter: ctx.scopeFilter } : {}),
  };
}

async function defaultMetaExecutor(args, ctx) {
  const operation = String(args.operation || '');
  if (operation === 'context' || operation === 'profiles') {
    const profile = await getSharedProfileStore(ctx.prisma).buildCompactProfileContext(ctx.userId, ctx.orgId, ctx.projectId || null);
    return { successful: true, data: { profile_context: compactText(profile, operation === 'context' ? 12000 : 4000) } };
  }
  if (operation === 'recall') return executeGovernedCoreRead('hivemind_recall', recallArgs(args.recall, ctx), ctx);
  if (operation !== 'save') return { successful: false, error: 'hivemind_meta_operation_invalid' };
  const save = args.save || {};
  const toolArgs = {
    title: save.title, content: save.content,
    tags: Array.isArray(save.tags) && save.tags.length >= 2 ? save.tags : ['hivemind', 'user-confirmed'],
    source_type: save.source_type || 'text',
    ...(save.project ? { project: save.project } : {}),
    ...(save.scope ? { scope: save.scope } : {}),
    _memory_admission: 'user_assertion', _require_explicit_scope: true,
  };
  return executeGovernedCoreWrite('hivemind_save_memory', toolArgs, ctx);
}

function workflowId(discovery) {
  return discovery?.workflowSessionId || discovery?.searchResponse?.data?.session?.id || discovery?.session?.id || null;
}

async function defaultConnectedExecutor(args, state, ctx, composio) {
  const action = String(args.action || '');
  if (action === 'search') {
    const queries = Array.isArray(args.queries) ? args.queries.slice(0, 8) : [];
    if (!queries.length) return { successful: false, error: 'connected_search_queries_required' };
    const useCases = queries.map(row => compactText(row?.use_case, 900)).filter(Boolean);
    const toolkits = Array.isArray(args.toolkits) ? args.toolkits.slice(0, 12) : [];
    const discovery = await composio.discoverSessionTools(ctx.orgId, {
      userId: ctx.userId, connectionScope: ctx.connectionScope || 'user', toolkits, useCases,
      allowDisconnected: true, sessionId: state.sessionId || null, includeCustomToolkit: false,
      manageConnections: false, hydrateSchemas: false, candidateLimit: 12,
      callbackUrl: ctx.composioCallbackOrigin,
      searchPayload: {
        queries,
        session: args.session || (state.workflowSessionId ? { id: state.workflowSessionId } : { generate_id: true }),
        search_strategy: args.search_strategy || 'auto',
      },
    });
    const compact = compactConnectedSearch(discovery.searchResponse || {
      data: {
        results: useCases.map(use_case => ({
          use_case,
          primary_tool_slugs: discovery.primaryToolSlugs || [],
          related_tool_slugs: discovery.relatedToolSlugs || [],
          recommended_plan_steps: discovery.recommendedPlanSteps || [],
        })),
        toolkit_connection_statuses: discovery.toolkitConnectionStatuses || {},
        next_steps_guidance: discovery.nextStepsGuidance || null,
        session: workflowId(discovery) ? { id: workflowId(discovery) } : null,
      },
    });
    return {
      successful: true, data: compact,
      state: {
        selectedSlugs: [...new Set([...(discovery.primaryToolSlugs || []), ...(discovery.relatedToolSlugs || [])])],
        sessionId: discovery.sessionId || state.sessionId,
        workflowSessionId: workflowId(discovery) || state.workflowSessionId,
      },
      disconnected: disconnectedToolkits(discovery.toolkitConnectionStatuses || compact.toolkit_connection_statuses),
    };
  }
  if (action === 'schemas') {
    const slugs = [...new Set((args.tool_slugs || []).map(String))];
    if (!slugs.length || slugs.some(slug => !state.selectedSlugs.includes(slug))) return { successful: false, error: 'connected_schema_slug_not_selected' };
    const schemas = await composio.getSessionToolSchemas(args.session_id || state.sessionId, slugs);
    return { successful: true, data: { tool_schemas: schemas }, state: { schemas: { ...state.schemas, ...schemas } } };
  }
  if (action === 'manage_connection' || action === 'wait_connection') {
    const toolkits = Array.isArray(args.toolkits) ? args.toolkits : [];
    if (!toolkits.length) return { successful: false, error: 'connected_toolkits_required' };
    const managed = await composio.manageSessionConnections(args.session_id || state.sessionId, toolkits, { reinitiateAll: action === 'manage_connection' });
    return { successful: true, data: managed, connection: { toolkits, ...managed } };
  }
  if (action !== 'execute') return { successful: false, error: 'connected_action_invalid' };
  const slug = String(args.tool_slug || '');
  if (!slug || !state.selectedSlugs.includes(slug)) return { successful: false, error: 'connected_execute_slug_not_selected' };
  const schema = state.schemas[slug];
  if (!schema?.input_schema) return { successful: false, error: 'connected_execute_schema_not_loaded' };
  const validate = new Ajv({ strict: false, allErrors: true }).compile(schema.input_schema);
  if (!validate(args.arguments || {})) {
    return { successful: false, error: 'schema_validation_failed', validation_errors: validate.errors?.slice(0, 8) || [] };
  }
  const authority = connectedToolAuthority(slug, schema);
  if (authority === 'write') return { successful: true, approval: { slug, arguments: args.arguments || {}, schema: schema.input_schema } };
  const receipt = (await composio.executeToolsParallel(ctx.orgId, [{ slug, arguments: args.arguments || {} }], {
    sessionId: state.sessionId, allowDirectFallback: false,
  }))[0];
  return { ...receipt, data: publicToolResult(receipt) };
}

async function createApproval(prisma, ctx, state, approval) {
  const toolArgs = {
    ...approval.arguments,
    _governed_tool_source: 'composio', _composio_slug: approval.slug,
    _harness_version: UNIFIED_META_HARNESS_VERSION,
    _graph_thread_id: ctx.unifiedGraphThreadId,
    _composio_session_id: state.sessionId,
    _input_schema: approval.schema,
  };
  const idempotencyKey = crypto.createHash('sha256').update(`unified:${ctx.orgId}:${ctx.userId}:${state.runId}:${approval.slug}:${jsonText(approval.arguments)}`).digest('hex');
  let row = await prisma.pendingWrite.findFirst({ where: { idempotencyKey, orgId: ctx.orgId, userId: ctx.userId } });
  if (!row) row = await prisma.pendingWrite.create({ data: {
    userId: ctx.userId, orgId: ctx.orgId, provider: 'composio', toolGroup: 'composio', toolName: approval.slug,
    toolArgs, argsHash: crypto.createHash('sha256').update(jsonText(toolArgs)).digest('hex'), traceId: state.runId,
    idempotencyKey, expiresAt: new Date(Date.now() + 15 * 60_000), preview: `${approval.slug} awaiting approval`, status: 'draft',
  } });
  return row;
}

function toolMessage(call, value) {
  return { role: 'tool', tool_call_id: call.id, name: call.name, content: jsonText(value) };
}

function outputShape(state, response, status = 'completed') {
  const sources = resultSources(state.receipts);
  return {
    status, summary: response, response,
    run: {
      id: state.runId, status: status === 'completed' ? 'sealed' : status,
      composioSessionId: state.sessionId,
      scratch: { harness_version: UNIFIED_META_HARNESS_VERSION, selected_tool_slugs: state.selectedSlugs, workflow_session_id: state.workflowSessionId },
    },
    steps: state.steps, sources, citations: sources, draftIds: state.pendingApproval ? [state.pendingApproval.id] : [],
    pendingActions: state.pendingApproval ? [{ id: state.pendingApproval.id }] : [], inputRequests: [], resumeState: null,
    followUps: [], usage: state.usage,
  };
}

export function createUnifiedMetaAgentGraph({ checkpointer, ctx, message, useTools = false, onEvent = () => {}, composio, prisma, modelStep, metaExecutor, connectedExecutor }) {
  const callModel = modelStep || defaultModelStep;
  const runMeta = metaExecutor || defaultMetaExecutor;
  const runConnected = connectedExecutor || defaultConnectedExecutor;
  const ledger = new GovernedAgentEventLedger({ prisma });

  const ensureRun = async runId => {
    if (!prisma?.agentRun?.create || !runId) return;
    const where = { id: runId, orgId: ctx.orgId, userId: ctx.userId };
    const existing = await prisma.agentRun.findFirst?.({ where });
    if (existing) return;
    try {
      await prisma.agentRun.create({ data: {
        id: runId, orgId: ctx.orgId, userId: ctx.userId,
        conversationId: `unified:${runId}`, goal: message, status: 'received', steps: [],
        scratch: { runtime: UNIFIED_META_HARNESS_VERSION, graph_thread_id: ctx.unifiedGraphThreadId, use_tools: useTools === true, event_sequence: 0 },
      } });
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
    }
  };

  const transition = async (state, status, patch = {}, detail = {}) => {
    const sequence = Number(state.eventSequence || 0) + 1;
    const appended = await ledger.append({
      orgId: ctx.orgId, userId: ctx.userId, runId: state.runId, sequence, type: 'state_transition',
      payload: { state: status, tool_slug: detail.tool_slug || null, reason_code: detail.reason_code || null },
    });
    if (prisma?.agentRun?.update) {
      await prisma.agentRun.update({ where: { id: state.runId }, data: {
        status, steps: patch.steps || state.steps || [], composioSessionId: patch.sessionId || state.sessionId || null,
        scratch: { runtime: UNIFIED_META_HARNESS_VERSION, graph_thread_id: ctx.unifiedGraphThreadId, use_tools: useTools === true,
          workflow_session_id: patch.workflowSessionId || state.workflowSessionId || null, selected_tool_slugs: patch.selectedSlugs || state.selectedSlugs || [], event_sequence: sequence },
      } }).catch(() => {});
    }
    onEvent({ ...safeEventEnvelope({ event: appended.event, runId: state.runId, state: status, sequence }), type: 'agent_state', state: status });
    return { ...patch, status, eventSequence: sequence };
  };

  const contextNode = async state => {
    const runId = state.runId || ctx.unifiedRunId || crypto.randomUUID();
    await ensureRun(runId);
    let profile = '';
    try { profile = await getSharedProfileStore(prisma).buildCompactProfileContext(ctx.userId, ctx.orgId, ctx.projectId || null); } catch {}
    const locale = ctx.language || 'en';
    const messages = [
      { role: 'system', content: systemPrompt({ useTools, locale }) },
      ...(profile ? [{ role: 'system', content: `Authenticated compact profile:\n${compactText(profile, 1800)}` }] : []),
      ...safeHistory(ctx.conversationHistory, Math.max(1, Math.min(6, Number(ctx.historyTurns) || 3))),
      { role: 'user', content: message },
    ];
    const patch = { runId, context: { locale, profile: compactText(profile, 1800) }, messages };
    return transition({ ...state, runId }, 'running', patch, { reason_code: 'turn_admitted' });
  };

  const modelNode = async state => {
    if (state.cycles >= MAX_STEPS) return { result: outputShape(state, 'I could not safely complete this request within the bounded execution steps.', 'error') };
    const turn = await callModel({
      messages: state.messages, tools: unifiedMetaTools({ useTools }), model: ctx.model,
      apiKey: ctx._apiKey, signal: ctx._signal, state,
    });
    const assistant = turn.message || turn;
    const usage = turn.usage ? [...state.usage, turn.usage] : state.usage;
    const messages = [...state.messages, { role: 'assistant', content: assistant.content || null, ...(assistant.tool_calls?.length ? { tool_calls: assistant.tool_calls } : {}) }];
    const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    if (calls.length) return { messages, pendingTool: parseUnifiedToolCall(calls[0]), cycles: state.cycles + 1, usage };
    if (invalidFinal(assistant.content, state.receipts) && state.repairs < 1) {
      return {
        messages: [...messages, { role: 'system', content: 'Your proposed answer did not present the successful receipt evidence. Answer the original request directly from the receipts now. Do not describe what you could do.' }],
        pendingTool: null, cycles: state.cycles + 1, repairs: state.repairs + 1, usage,
      };
    }
    const response = markdownText(assistant.content, 24000);
    onEvent({ type: 'answer_delta', text: response });
    return { messages, pendingTool: null, usage, result: outputShape({ ...state, messages, usage }, response) };
  };

  const toolNode = async state => {
    const call = state.pendingTool;
    const fingerprint = crypto.createHash('sha256').update(`${call.name}:${jsonText(call.args)}`).digest('hex');
    if (state.callFingerprints.includes(fingerprint)) {
      const receipt = { tool: call.name, successful: false, error: 'identical_tool_call_already_completed' };
      return { pendingTool: null, messages: [...state.messages, toolMessage(call, receipt)], receipts: [...state.receipts, receipt] };
    }
    onEvent({ type: 'tool_start', name: call.name, arguments: call.args, run_id: state.runId });
    let receipt = call.name === 'hivemind_meta'
      ? await runMeta(call.args, ctx, state)
      : await runConnected(call.args, state, ctx, composio);
    const statePatch = receipt?.state || {};
    if (receipt?.approval) {
      const row = await createApproval(prisma, ctx, state, receipt.approval);
      receipt = { successful: true, status: 'approval_required', draft_id: row.id, tool_slug: receipt.approval.slug, message: 'Draft ready for approval. Nothing has been sent.' };
      onEvent({ type: 'tool_result', name: receipt.tool_slug, status: 'draft_created', summary: receipt.message, run_id: state.runId });
      const patch = {
        ...statePatch, pendingTool: null, pendingApproval: row,
        callFingerprints: [...state.callFingerprints, fingerprint],
        messages: [...state.messages, toolMessage(call, receipt)], receipts: [...state.receipts, { ...receipt, data: receipt }],
        steps: [...state.steps, { kind: 'write', slug: receipt.tool_slug, status: 'draft_created', summary: receipt.message }],
      };
      return transition(state, 'awaiting_approval', patch, { tool_slug: receipt.tool_slug, reason_code: 'write_approval_required' });
    }
    if (receipt?.disconnected?.length || receipt?.connection?.redirectUrl) {
      const toolkits = receipt.disconnected?.length ? receipt.disconnected : receipt.connection.toolkits;
      const managed = receipt.connection || await composio.manageSessionConnections(statePatch.sessionId || state.sessionId, toolkits, { reinitiateAll: true });
      const request = {
        kind: 'connect_account', toolkit: toolkits[0], provider: toolkits[0], blocking: true,
        prompt: localized(ctx.language, 'connect', toolkits[0]), redirect_url: managed.redirectUrl || null,
        options: [
          { id: 'connect', label: `Connect ${toolkits[0]}`, href: managed.redirectUrl || null, open_url: true, value: managed.redirectUrl || null },
          { id: 'connected', label: localized(ctx.language, 'retry', toolkits[0]), value: 'retry_connection' },
        ],
      };
      const patch = {
        ...statePatch, pendingTool: null, pendingConnection: request,
        callFingerprints: [...state.callFingerprints, fingerprint],
        messages: [...state.messages, toolMessage(call, { ...receipt.data, status: 'connection_required', ...request })],
        receipts: [...state.receipts, { tool: call.name, successful: true, data: receipt.data }],
        steps: [...state.steps, { kind: 'connection', slug: toolkits[0], status: 'waiting', summary: request.prompt }],
      };
      return transition(state, 'awaiting_input', patch, { tool_slug: toolkits[0], reason_code: 'connection_required' });
    }
    const exposed = publicToolResult(receipt);
    const underlying = call.name === 'hivemind_connected_task' && call.args.action === 'execute' ? call.args.tool_slug : call.name;
    onEvent({ type: 'tool_result', name: underlying, status: receipt?.successful === false ? 'error' : 'completed', summary: receipt?.error || 'Completed', run_id: state.runId });
    return {
      ...statePatch, pendingTool: null, callFingerprints: [...state.callFingerprints, fingerprint],
      messages: [...state.messages, toolMessage(call, exposed)],
      receipts: [...state.receipts, { tool: underlying, successful: receipt?.successful !== false, data: exposed, error: receipt?.error || null }],
      steps: [...state.steps, { kind: 'tool', slug: underlying, status: receipt?.successful === false ? 'error' : 'completed', summary: receipt?.error || 'Completed' }],
    };
  };

  const connectionNode = async state => {
    interrupt({ run_id: state.runId, ...state.pendingConnection });
    const accounts = await composio.listConnectedAccounts(ctx.orgId, { userId: ctx.userId, connectionScope: ctx.connectionScope || 'user' });
    const toolkit = String(state.pendingConnection?.toolkit || '').toLowerCase();
    const connected = accounts.some(row => String(row?.toolkit || '').toLowerCase() === toolkit && row?.status === 'ACTIVE');
    if (!connected) return { pendingConnection: { ...state.pendingConnection, prompt: localized(ctx.language, 'waiting', toolkit) } };
    const receipt = { successful: true, status: 'connected', toolkit };
    return {
      pendingConnection: null,
      messages: [...state.messages, { role: 'system', content: jsonText({ connected: receipt, instruction: 'Continue the original request without repeating completed search work.' }) }],
      steps: [...state.steps, { kind: 'connection', slug: toolkit, status: 'completed', summary: 'Connection active' }],
    };
  };

  const approvalNode = async state => {
    // The approval card is editable through the existing HTTP contract. Read
    // the canonical draft again on resume so the graph executes the reviewed
    // values, not the pre-interrupt checkpoint snapshot.
    const row = await prisma.pendingWrite.findFirst({
      where: { id: state.pendingApproval.id, orgId: ctx.orgId, userId: ctx.userId },
    });
    if (!row) throw new Error('unified_approval_draft_missing');
    const choice = interrupt({ kind: 'approval', run_id: state.runId, approval_id: row.id, prompt: localized(ctx.language, 'approval') });
    const action = compactText(choice?.action || choice?.value || choice, 30).toLowerCase();
    if (['reject', 'cancel', 'cancelled'].includes(action)) {
      await prisma.pendingWrite.updateMany({ where: { id: row.id, status: 'draft' }, data: { status: 'cancelled' } });
      return {
        pendingApproval: null,
        messages: [...state.messages, { role: 'system', content: jsonText({ approval: 'rejected', message: 'Draft rejected. Nothing was sent.' }) }],
        steps: [...state.steps, { kind: 'approval', slug: row.toolName, status: 'cancelled', summary: 'Draft rejected; nothing sent' }],
      };
    }
    if (action !== 'approve') throw new Error('unified_approval_decision_invalid');
    const claimed = await prisma.pendingWrite.updateMany({ where: { id: row.id, orgId: ctx.orgId, userId: ctx.userId, status: 'draft', expiresAt: { gt: new Date() } }, data: { status: 'approved', approvedAt: new Date() } });
    if (claimed.count !== 1) throw new Error('unified_approval_state_changed');
    const args = { ...row.toolArgs };
    for (const key of Object.keys(args)) if (key.startsWith('_')) delete args[key];
    const receipt = (await composio.executeToolsParallel(ctx.orgId, [{ slug: row.toolName, arguments: args }], { sessionId: row.toolArgs._composio_session_id, allowDirectFallback: false }))[0];
    const successful = receipt?.successful === true;
    await prisma.pendingWrite.update({ where: { id: row.id }, data: { status: successful ? 'sent' : 'failed', sentAt: successful ? new Date() : null, result: successful ? publicToolResult(receipt) : null, errorMsg: successful ? null : compactText(receipt?.error, 1000) } });
    const exposed = publicToolResult(receipt);
    return {
      pendingApproval: null,
      messages: [...state.messages, { role: 'system', content: jsonText({ approval: successful ? 'executed_once' : 'execution_failed', receipt: exposed }) }],
      receipts: [...state.receipts, { tool: row.toolName, successful, data: exposed, error: receipt?.error || null }],
      steps: [...state.steps, { kind: 'approval', slug: row.toolName, status: successful ? 'completed' : 'failed', summary: successful ? 'Approved action completed once' : 'Approved action failed' }],
    };
  };

  const routeModel = state => state.result ? 'seal' : (state.pendingTool ? 'tool' : 'model');
  const routeTool = state => state.pendingConnection ? 'connection' : (state.pendingApproval ? 'approval' : 'model');
  const routeConnection = state => state.pendingConnection ? 'connection' : 'model';
  const sealNode = async state => {
    onEvent({ type: 'finish', text: state.result.response });
    return transition(state, state.result.status === 'completed' ? 'sealed' : 'failed', {}, { reason_code: state.result.status });
  };

  return new StateGraph(State)
    .addNode('admit_context', contextNode)
    .addNode('model', modelNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.2 } })
    .addNode('tool', toolNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.3 } })
    .addNode('connection', connectionNode)
    .addNode('approval', approvalNode)
    .addNode('seal', sealNode)
    .addEdge(START, 'admit_context').addEdge('admit_context', 'model')
    .addConditionalEdges('model', routeModel, ['model', 'tool', 'seal'])
    .addConditionalEdges('tool', routeTool, ['model', 'connection', 'approval'])
    .addConditionalEdges('connection', routeConnection, ['connection', 'model'])
    .addEdge('approval', 'model').addEdge('seal', END)
    .compile({ checkpointer });
}

let checkpointerPromise;
async function productionCheckpointer() {
  if (!checkpointerPromise) checkpointerPromise = createPostgresCheckpointer({
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
    schema: 'hivemind_unified_meta_langgraph',
  }).then(value => value.checkpointer).catch(error => { checkpointerPromise = null; throw error; });
  return checkpointerPromise;
}

function threadId(ctx) {
  if (ctx.unifiedGraphThreadId) return ctx.unifiedGraphThreadId;
  const identity = `${ctx.orgId}\0${ctx.userId}\0${ctx.threadId || ctx.conversationId || ctx.durableChatTurnId || crypto.randomUUID()}`;
  return `unified:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 40)}:v2`;
}

function interruptedResult(output, graphThreadId, useTools) {
  const request = output?.__interrupt__?.[0]?.value || {};
  const approval = request.kind === 'approval';
  const response = approval ? 'Draft ready for approval. Nothing has been sent.' : request.prompt;
  return {
    status: approval ? 'pending' : 'needs_input', summary: response, response,
    run: { id: request.run_id || output.runId, status: approval ? 'awaiting_approval' : 'awaiting_input', composioSessionId: output.sessionId, scratch: { harness_version: UNIFIED_META_HARNESS_VERSION } },
    steps: output.steps || [], draftIds: request.approval_id ? [request.approval_id] : [], pendingActions: request.approval_id ? [{ id: request.approval_id }] : [],
    inputRequests: approval ? [] : [{ ...request, step_index: 0, step_id: 'unified-langgraph-input' }],
    resumeState: { kind: 'unified_langgraph', graph_thread_id: graphThreadId, run_id: request.run_id || output.runId, use_tools: useTools === true, results: approval ? [] : [{ inputRequest: request }] },
  };
}

export async function runUnifiedMetaAgent({ message, useTools = false, ctx = {}, onEvent, prisma = null, composio = null, choice = null, graph = null, checkpointer = null, modelStep = null, metaExecutor = null, connectedExecutor = null } = {}) {
  const db = prisma || ctx.prisma;
  if (!db) throw new Error('unified_prisma_required');
  const connector = composio || await import('../connectors/composio/composio-service.js');
  const graphThreadId = threadId(ctx);
  const runId = ctx.unifiedRunId || choice?.run_id || crypto.randomUUID();
  const runtimeCtx = { ...ctx, prisma: db, unifiedRunId: runId, unifiedGraphThreadId: graphThreadId };
  const runtime = graph || createUnifiedMetaAgentGraph({ checkpointer: checkpointer || await productionCheckpointer(), ctx: runtimeCtx, message, useTools, onEvent, composio: connector, prisma: db, modelStep, metaExecutor, connectedExecutor });
  const config = { configurable: { thread_id: graphThreadId }, recursionLimit: 64, tags: [UNIFIED_META_HARNESS_VERSION], metadata: { use_tools: useTools, locale: ctx.language || 'en' } };
  const output = choice ? await runtime.invoke(new Command({ resume: choice }), config) : await runtime.invoke({ runId }, config);
  return output?.__interrupt__?.length ? interruptedResult(output, graphThreadId, useTools) : output.result;
}

export function isUnifiedMetaHarnessVersion(value) {
  return String(value || '') === UNIFIED_META_HARNESS_VERSION;
}

/** Resume the exact LangGraph checkpoint referenced by an editable PendingWrite. */
export async function resumeUnifiedMetaApproval({ row, action, ctx = {}, onEvent, prisma, composio = null } = {}) {
  const graphThreadId = row?.toolArgs?._graph_thread_id;
  if (!graphThreadId || !isUnifiedMetaHarnessVersion(row?.toolArgs?._harness_version)) {
    throw new Error('unified_approval_checkpoint_missing');
  }
  if (!row?.traceId || row?.orgId !== ctx.orgId || row?.userId !== ctx.userId) {
    throw new Error('unified_approval_scope_invalid');
  }
  return runUnifiedMetaAgent({
    message: '',
    useTools: true,
    ctx: { ...ctx, unifiedGraphThreadId: graphThreadId, unifiedRunId: row.traceId },
    onEvent,
    prisma,
    composio,
    choice: { action: action === 'cancel' ? 'reject' : 'approve', approval_id: row.id, run_id: row.traceId },
  });
}

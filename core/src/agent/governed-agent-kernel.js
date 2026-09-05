import { createHash, randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { Annotation, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { chatCompletionFetch } from '../llm/chat-provider.js';
import { loadGovernedSkill } from './governed-agent-skills.js';

const MODEL = 'google/gemini-2.5-flash-lite';
const READ_VERBS = new Set(['fetch', 'find', 'get', 'list', 'read', 'search', 'retrieve']);
const WRITE_VERBS = new Set(['add', 'append', 'archive', 'create', 'delete', 'modify', 'patch', 'post', 'remove', 'reply', 'send', 'set', 'update']);

const GraphState = Annotation.Root({
  runId: Annotation({ reducer: (_l, r) => r, default: () => null }),
  status: Annotation({ reducer: (_l, r) => r, default: () => 'received' }),
  locale: Annotation({ reducer: (_l, r) => r, default: () => 'en' }),
  intent: Annotation({ reducer: (_l, r) => r, default: () => null }),
  connected: Annotation({ reducer: (_l, r) => r, default: () => [] }),
  sessionId: Annotation({ reducer: (_l, r) => r, default: () => null }),
  workflowSessionId: Annotation({ reducer: (_l, r) => r, default: () => null }),
  capabilities: Annotation({ reducer: (_l, r) => r, default: () => [] }),
  receipts: Annotation({ reducer: (_l, r) => r, default: () => [] }),
  steps: Annotation({ reducer: (_l, r) => r, default: () => [] }),
  searchQueries: Annotation({ reducer: (_l, r) => r, default: () => [] }),
  searchQuery: Annotation({ reducer: (_l, r) => r, default: () => '' }),
  decision: Annotation({ reducer: (_l, r) => r, default: () => null }),
  toolArgs: Annotation({ reducer: (_l, r) => r, default: () => null }),
  fieldValues: Annotation({ reducer: (_l, r) => r, default: () => ({}) }),
  pendingInput: Annotation({ reducer: (_l, r) => r, default: () => null }),
  pendingApprovalId: Annotation({ reducer: (_l, r) => r, default: () => null }),
  cycles: Annotation({ reducer: (_l, r) => r, default: () => 0 }),
  result: Annotation({ reducer: (_l, r) => r, default: () => null }),
});

const compact = (value, limit = 18000) => {
  const seen = new WeakSet();
  const project = (input, depth = 0) => {
    if (input == null || typeof input === 'boolean' || typeof input === 'number') return input;
    if (typeof input === 'string') return input.slice(0, 1600);
    if (depth > 6) return '[omitted]';
    if (Array.isArray(input)) return input.slice(0, 24).map(item => project(item, depth + 1));
    if (typeof input === 'object') {
      if (seen.has(input)) return '[circular]';
      seen.add(input);
      return Object.fromEntries(Object.entries(input).slice(0, 36).map(([key, item]) => [key, project(item, depth + 1)]));
    }
    return null;
  };
  const projected = project(value);
  const json = JSON.stringify(projected);
  return json.length <= limit ? projected : { summary: json.slice(0, limit), truncated: true };
};

async function jsonDecision(system, input, signal) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await chatCompletionFetch(MODEL, { method: 'POST', signal, body: JSON.stringify({
      temperature: 0, max_tokens: 1600, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: `${system}\nReturn exactly one JSON object.${attempt ? ' Repair the prior contract failure; no prose or markdown.' : ''}` },
        { role: 'user', content: JSON.stringify(compact(input)) }],
    }) }, { useCase: 'governed_graph' });
    if (!response.ok) {
      lastError = new Error(`governed_model_${response.status}`);
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
      throw lastError;
    }
    try {
      const payload = await response.json();
      const text = payload?.choices?.[0]?.message?.content;
      if (!text) throw new Error('governed_model_empty');
      const parsed = JSON.parse(String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('governed_model_object_required');
      return parsed;
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('governed_model_failed');
}

function authority(slug = '') {
  const parts = String(slug).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const verb = parts[1] || parts[0];
  return READ_VERBS.has(verb) ? 'read' : WRITE_VERBS.has(verb) ? 'write' : 'unknown';
}

function destinationEmails(value) {
  return JSON.stringify(value || {}).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.map(x => x.toLowerCase()) || [];
}

function isPlaceholder(email) {
  return /@(example\.(com|net|org)|test\.com)$/i.test(email);
}

function receiptSummary(data) {
  if (data == null) return 'No data returned';
  if (typeof data === 'string') return data.slice(0, 180);
  const candidate = data?.name || data?.title || data?.subject || data?.snippet || data?.message || data?.data?.name;
  return candidate ? String(candidate).slice(0, 180) : 'Provider read completed';
}

function resultShape(state, summary, status = state.status) {
  const draftIds = state.pendingApprovalId ? [state.pendingApprovalId] : [];
  return { response: summary, summary, status, run: { id: state.runId, status, composioSessionId: state.sessionId,
    scratch: { harness_version: 'langgraph-native-v1', read_results: state.receipts } },
    steps: state.steps, draftIds, pendingActions: draftIds.map(id => ({ id })),
    resumeState: state.pendingInput ? { kind: 'governed_langgraph', fields: state.pendingInput.fields } : null };
}

export function createGovernedKernel({ checkpointer, ctx, message, onEvent = () => {}, composio, prisma }) {
  const persist = async (state, patch = {}) => {
    if (!prisma?.agentRun?.update || !state.runId) return;
    await prisma.agentRun.update({ where: { id: state.runId }, data: {
      status: patch.status || state.status,
      steps: patch.steps || state.steps,
      composioSessionId: patch.sessionId === undefined ? state.sessionId : patch.sessionId,
      scratch: compact({ runtime: 'langgraph-native-v1', locale: patch.locale || state.locale,
        intent: patch.intent === undefined ? state.intent : patch.intent,
        capabilities: patch.capabilities === undefined ? state.capabilities : patch.capabilities,
        receipts: patch.receipts === undefined ? state.receipts : patch.receipts,
        searchQueries: patch.searchQueries === undefined ? state.searchQueries : patch.searchQueries,
        pendingInput: patch.pendingInput === undefined ? state.pendingInput : patch.pendingInput,
        pendingApprovalId: patch.pendingApprovalId === undefined ? state.pendingApprovalId : patch.pendingApprovalId }, 50000),
    } });
  };

  const contextNode = async state => {
    const accounts = await composio.listConnectedAccounts(ctx.orgId);
    const connected = [...new Set(accounts.filter(row => row.status === 'ACTIVE').map(row => row.toolkit).filter(Boolean))];
    const runId = state.runId || randomUUID();
    if (prisma?.agentRun?.create && !state.runId) await prisma.agentRun.create({ data: { id: runId, orgId: ctx.orgId,
      userId: ctx.userId, conversationId: `${ctx.conversationId || ctx.threadId || 'chat'}:${runId}`.slice(0, 160), goal: message, status: 'context_loaded', steps: [],
      scratch: { runtime: 'langgraph-native-v1' } } });
    onEvent({ type: 'agent_state', state: 'context_loaded', run_id: runId });
    return { runId, connected, status: 'context_loaded' };
  };

  const intentNode = async state => {
    const intent = await jsonDecision(`Resolve language-neutral intent. Active skill: ${loadGovernedSkill('intent').content}
Contract: {locale:string,apps:string[],kind:"read"|"write",use_case:string,outcomes:[{id:string,kind:"read"|"draft",description:string}],known_facts:object,missing_business_context:boolean,business_question:string}. Preserve explicitly named people and supplied destinations in known_facts.`,
    { message, connected: state.connected, conversation_context: ctx.conversationHistory || [] }, ctx._signal);
    if (!Array.isArray(intent.outcomes) || !intent.outcomes.length || !['read', 'write'].includes(intent.kind)) throw new Error('governed_intent_contract');
    const locale = String(intent.locale || ctx.language || 'en').slice(0, 20);
    await persist(state, { intent, locale, status: 'intent_resolved' });
    onEvent({ type: 'agent_state', state: 'intent_resolved', run_id: state.runId });
    return { intent, locale, searchQuery: String(intent.use_case || message).slice(0, 500), status: 'intent_resolved' };
  };

  const discoverNode = async state => {
    const query = state.searchQuery || state.intent?.use_case || message;
    const toolkits = (state.intent?.apps?.length ? state.intent.apps : state.connected).slice(0, 12);
    onEvent({ type: 'tool_start', name: 'COMPOSIO_SEARCH_TOOLS', args: { query } });
    const discovery = await composio.discoverSessionTools(ctx.orgId, { toolkits, useCases: [query], allowDisconnected: true,
      searchPayload: { queries: [{ use_case: query, known_fields: JSON.stringify(state.intent?.known_facts || {}) }],
        session: state.workflowSessionId ? { id: state.workflowSessionId } : { generate_id: true }, search_strategy: 'auto' } });
    const cards = [...state.capabilities];
    for (const tool of discovery.tools || []) {
      const slug = tool?._composio?.slug;
      const raw = discovery.toolSchemas?.[slug];
      if (!slug || !raw?.input_schema?.properties) continue;
      const card = { slug, toolkit: String(raw.toolkit || tool._composio?.toolkit || '').toLowerCase(), authority: authority(slug),
        description: String(raw.description || tool.function?.description || '').slice(0, 800), schema: raw.input_schema };
      const index = cards.findIndex(item => item.slug === slug);
      if (index >= 0) cards[index] = card; else cards.push(card);
    }
    const steps = [...state.steps, { kind: 'search', slug: 'COMPOSIO_SEARCH_TOOLS', status: 'completed', summary: `${cards.length} capabilities discovered` }];
    const searchQueries = [...state.searchQueries, query].slice(-4);
    const patch = { capabilities: cards.slice(0, 48), sessionId: discovery.sessionId || state.sessionId,
      workflowSessionId: discovery.workflowSessionId || state.workflowSessionId, steps, searchQueries, status: 'capability_discovered' };
    await persist(state, patch);
    onEvent({ type: 'tool_result', name: 'COMPOSIO_SEARCH_TOOLS', status: 'completed', summary: `${cards.length} capabilities discovered` });
    return patch;
  };

  const reasonNode = async state => {
    const covered = new Set(state.receipts.filter(row => row.successful).flatMap(row => row.outcome_ids || []));
    if (state.intent.outcomes.every(outcome => covered.has(outcome.id))) return { decision: { action: 'done' }, status: 'ready_to_synthesize' };
    if (state.cycles >= 8) return { decision: { action: 'ask', question: 'I could not find a connected capability that can resolve the remaining information. Please provide that business detail.', fields: ['missing_information'] }, status: 'awaiting_input' };
    const capabilities = state.capabilities.map(card => ({ slug: card.slug, toolkit: card.toolkit, authority: card.authority,
      description: card.description, required: card.schema.required || [], fields: Object.keys(card.schema.properties || {}) }));
    const decision = await jsonDecision(`Act as a self-governing tool agent. Active skill: ${loadGovernedSkill('dependency').content}
Choose one next action: {action:"search"|"read"|"draft"|"ask"|"done",slug?:string,query?:string,outcome_ids?:string[],question?:string,fields?:string[],reason:string}. Use discovered capabilities before searching again. Reads used only to resolve a prerequisite use outcome_ids:[]. Never ask for provider IDs or account names. A write is only draft. Search queries must be materially new. If the catalog lacks the required reader after two searches, ask for a human-readable business fact or explain the capability gap.`,
      { message, intent: state.intent, capabilities, receipts: state.receipts.map(row => ({ slug: row.slug, successful: row.successful,
        outcome_ids: row.outcome_ids, summary: receiptSummary(row.data) })), prior_searches: state.searchQueries, fields: state.fieldValues }, ctx._signal);
    if (!['search', 'read', 'draft', 'ask', 'done'].includes(decision.action)) throw new Error('governed_action_contract');
    if (decision.action === 'search') {
      const query = String(decision.query || '').trim();
      if (!query || state.searchQueries.map(x => x.toLowerCase()).includes(query.toLowerCase()) || state.searchQueries.length >= 3) {
        return { decision: { action: 'ask', question: 'The connected integration does not expose the reader needed to resolve this automatically. Please provide the missing business information.', fields: ['missing_information'] }, status: 'awaiting_input', cycles: state.cycles + 1 };
      }
      return { decision, searchQuery: query.slice(0, 500), cycles: state.cycles + 1, status: 'discovering_dependency' };
    }
    return { decision, cycles: state.cycles + 1, status: decision.action === 'ask' ? 'awaiting_input' : 'planned' };
  };

  const prepareNode = async state => {
    const card = state.capabilities.find(item => item.slug === state.decision?.slug);
    if (!card) throw new Error('governed_capability_not_discovered');
    if (state.decision.action === 'read' && card.authority !== 'read') throw new Error('governed_read_authority_denied');
    if (state.decision.action === 'draft' && card.authority !== 'write') throw new Error('governed_write_authority_denied');
    const args = await jsonDecision(`Generate only arguments for the selected schema. Use explicit user facts and successful receipts. Never copy example values from the schema, invent identifiers, or invent destinations. Omit unknown optional fields.`,
      { message, intent: state.intent, selected: card, fields: state.fieldValues,
        receipts: state.receipts.map(row => ({ slug: row.slug, successful: row.successful, data: compact(row.data, 5000) })) }, ctx._signal);
    const ajv = new Ajv({ strict: false, allErrors: true });
    if (!ajv.compile(card.schema)(args)) throw new Error('governed_arguments_invalid');
    if (state.decision.action === 'draft') {
      const supported = new Set([...destinationEmails(message), ...state.receipts.flatMap(row => destinationEmails(row.data))]);
      const unsupported = destinationEmails(args).filter(email => isPlaceholder(email) || !supported.has(email));
      if (unsupported.length) return { decision: { action: 'search', query: 'resolve the named destination from connected account records', reason: 'Destination evidence required' },
        searchQuery: 'resolve the named destination from connected account records', toolArgs: null, status: 'discovering_dependency' };
    }
    return { toolArgs: args, status: 'arguments_validated' };
  };

  const executeNode = async state => {
    const card = state.capabilities.find(item => item.slug === state.decision.slug);
    const [receipt] = await composio.executeToolsParallel(ctx.orgId, [{ slug: card.slug, arguments: state.toolArgs }],
      { sessionId: state.sessionId, allowDirectFallback: false });
    const row = { slug: card.slug, successful: receipt?.successful === true, data: compact(receipt?.data, 7000),
      error: receipt?.successful ? null : 'Provider read failed', outcome_ids: state.decision.outcome_ids || [] };
    const receipts = [...state.receipts, row];
    const steps = [...state.steps, { kind: 'read', slug: card.slug, status: row.successful ? 'completed' : 'error', summary: row.successful ? receiptSummary(receipt.data) : row.error }];
    await persist(state, { receipts, steps, status: row.successful ? 'tool_executed' : 'tool_failed' });
    onEvent({ type: 'tool_result', name: card.slug, status: row.successful ? 'completed' : 'error', summary: steps.at(-1).summary });
    return { receipts, steps, toolArgs: null, decision: null, status: row.successful ? 'tool_executed' : 'tool_failed' };
  };

  const draftNode = async state => {
    const card = state.capabilities.find(item => item.slug === state.decision.slug);
    const toolArgs = { ...state.toolArgs, _composio_slug: card.slug, _harness_version: 'langgraph-native-v1', _input_schema: card.schema };
    const idempotencyKey = createHash('sha256').update(`graph:${ctx.orgId}:${ctx.userId}:${state.runId}:${card.slug}:${JSON.stringify(toolArgs)}`).digest('hex');
    let row = await prisma.pendingWrite.findFirst({ where: { idempotencyKey, orgId: ctx.orgId, userId: ctx.userId } });
    if (!row) row = await prisma.pendingWrite.create({ data: { userId: ctx.userId, orgId: ctx.orgId, provider: 'composio', toolGroup: 'composio',
      toolName: card.slug, toolArgs, argsHash: createHash('sha256').update(JSON.stringify(toolArgs)).digest('hex'), traceId: state.runId,
      idempotencyKey, expiresAt: new Date(Date.now() + 15 * 60_000), preview: `${card.slug} awaiting approval`.slice(0, 200), status: 'draft' } });
    const steps = [...state.steps, { kind: 'write', slug: card.slug, status: 'draft_created', summary: 'Draft ready for approval; not sent' }];
    const receipts = [...state.receipts, { slug: card.slug, successful: true, outcome_ids: state.decision.outcome_ids || [], draft_id: row.id, status: 'draft_created' }];
    const summary = 'Draft ready for approval. Nothing has been sent.';
    const patch = { pendingApprovalId: row.id, receipts, steps, status: 'awaiting_approval', result: resultShape({ ...state, pendingApprovalId: row.id, receipts, steps }, summary, 'pending') };
    await persist(state, patch);
    return patch;
  };

  const humanNode = async state => {
    const request = state.pendingInput || { kind: 'field_input', prompt: state.decision?.question || 'What information should I use?',
      fields: (state.decision?.fields || ['missing_information']).map(id => ({ id, name: id, label: id.replaceAll('_', ' '), type: 'text', required: true })) };
    await persist(state, { pendingInput: request, status: 'awaiting_input' });
    const answer = interrupt({ run_id: state.runId, ...request });
    return { fieldValues: { ...state.fieldValues, ...(answer?.values || answer || {}) }, pendingInput: null, decision: null, status: 'resumed' };
  };

  const synthNode = async state => {
    const output = await jsonDecision(`Synthesize the final response in ${state.locale}. Active skill: ${loadGovernedSkill('synthesis').content}
Contract: {response:string}. Use only successful receipts. State capability gaps honestly.`, { message, intent: state.intent, receipts: state.receipts,
      steps: state.steps }, ctx._signal);
    const summary = String(output.response || 'I could not complete the request from available evidence.').slice(0, 5000);
    const status = state.receipts.some(row => row.draft_id) ? 'pending' : 'completed';
    const result = resultShape(state, summary, status);
    await persist(state, { status: status === 'completed' ? 'done' : 'awaiting_approval' });
    return { result, status: status === 'completed' ? 'done' : 'awaiting_approval' };
  };

  const routeReason = state => ({ search: 'discover', read: 'prepare', draft: 'prepare', ask: 'await_human', done: 'synthesize' }[state.decision?.action] || 'synthesize');
  const routePrepared = state => state.decision?.action === 'draft' ? 'draft' : state.decision?.action === 'search' ? 'discover' : 'execute';
  return new StateGraph(GraphState)
    .addNode('context', contextNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.2 } })
    .addNode('intent', intentNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.2 } })
    .addNode('discover', discoverNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.3 } })
    .addNode('reason', reasonNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.2 } })
    .addNode('prepare', prepareNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.2 } })
    .addNode('execute', executeNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.4 } })
    .addNode('draft', draftNode)
    .addNode('await_human', humanNode)
    .addNode('synthesize', synthNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.2 } })
    .addEdge(START, 'context').addEdge('context', 'intent').addEdge('intent', 'discover')
    .addConditionalEdges('reason', routeReason, ['discover', 'prepare', 'await_human', 'synthesize'])
    .addConditionalEdges('prepare', routePrepared, ['discover', 'execute', 'draft'])
    .addEdge('discover', 'reason').addEdge('execute', 'reason').addEdge('await_human', 'reason')
    .addEdge('draft', END).addEdge('synthesize', END)
    .compile({ checkpointer });
}

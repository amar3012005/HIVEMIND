import { createHash, randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { Annotation, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { chatCompletionFetch } from '../llm/chat-provider.js';
import { loadGovernedSkill } from './governed-agent-skills.js';
import { loadGovernedConversationContext } from './governed-conversation-context.js';

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
  conversationContext: Annotation({ reducer: (_l, r) => r, default: () => [] }),
  connectionRequest: Annotation({ reducer: (_l, r) => r, default: () => null }),
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

function semanticTokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function bestCapability(cards, intent) {
  const wanted = semanticTokens([intent?.use_case, ...(intent?.outcomes || []).map(item => item.description)].join(' '));
  return [...cards].sort((a, b) => {
    const score = card => [...semanticTokens(`${card.slug} ${card.description}`)].filter(token => wanted.has(token)).length;
    return score(b) - score(a);
  })[0] || null;
}

function destinationEmails(value) {
  return JSON.stringify(value || {}).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.map(x => x.toLowerCase()) || [];
}

function isPlaceholder(email) {
  return /@(example\.(com|net|org)|test\.com)$/i.test(email);
}

function humanQuestion(value) {
  const question = String(value || '').trim();
  if (/\b(?:provider|message|thread|person|post|account)[ _-]?(?:id|urn)\b|\burn\b/i.test(question)) {
    return 'The connected integration cannot resolve this item automatically. Please share a human-readable link or paste the relevant content.';
  }
  return question || 'What business information should I use?';
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
  const emitState = (state, status, extra = {}) => onEvent({ type: 'agent_state', state: status,
    run_id: state.runId || extra.run_id || null, ...extra });
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
    const conversationContext = await loadGovernedConversationContext({ prisma, orgId: ctx.orgId, userId: ctx.userId,
      conversationId: ctx.threadId || ctx.conversationId, turns: ctx.historyTurns });
    if (prisma?.agentRun?.create && !state.runId) await prisma.agentRun.create({ data: { id: runId, orgId: ctx.orgId,
      userId: ctx.userId, conversationId: `${ctx.conversationId || ctx.threadId || 'chat'}:${runId}`.slice(0, 160), goal: message, status: 'context_loaded', steps: [],
      scratch: { runtime: 'langgraph-native-v1' } } });
    onEvent({ type: 'agent_state', state: 'context_loaded', run_id: runId });
    return { runId, connected, conversationContext, status: 'context_loaded' };
  };

  const intentNode = async state => {
    const intent = await jsonDecision(`Resolve language-neutral intent. Active skill: ${loadGovernedSkill('intent').content}
Contract: {locale:string,apps:string[],kind:"read"|"write",use_case:string,outcomes:[{id:string,kind:"read"|"draft",description:string}],known_facts:object,missing_business_context:boolean,business_question:string}. Preserve explicitly named people and supplied destinations in known_facts.`,
    { message, connected: state.connected, conversation_context: state.conversationContext }, ctx._signal);
    if (!Array.isArray(intent.outcomes) || !intent.outcomes.length || !['read', 'write'].includes(intent.kind)) throw new Error('governed_intent_contract');
    const locale = String(intent.locale || ctx.language || 'en').slice(0, 20);
    await persist(state, { intent, locale, status: 'intent_resolved' });
    onEvent({ type: 'agent_state', state: 'intent_resolved', run_id: state.runId });
    return { intent, locale, searchQuery: String(intent.use_case || message).slice(0, 500), status: 'intent_resolved' };
  };

  const missingApp = state => (state.intent?.apps || []).map(app => String(app).toLowerCase())
    .find(app => app !== 'hivemind' && !state.connected.includes(app));

  const prepareConnectionNode = async state => {
    const toolkit = missingApp(state);
    if (!toolkit) return { connectionRequest: null, status: 'resumed' };
    let callbackUrl = null;
    if (ctx.composioCallbackOrigin) {
      const url = new URL('/hivemind/app/connect/composio/callback', ctx.composioCallbackOrigin);
      url.searchParams.set('composio_toolkit', toolkit);
      callbackUrl = url.toString();
    }
    const link = await composio.createConnectLink(toolkit, ctx.orgId, { callbackUrl });
    const request = { kind: 'connect_account', toolkit, provider: toolkit, blocking: true,
      prompt: `Connect ${toolkit} to continue, then return here.`,
      options: [{ id: 'connect', label: `Connect ${toolkit}`, href: link.redirectUrl, open_url: true, value: link.redirectUrl },
        { id: 'connected', label: `I've connected ${toolkit} — continue`, value: 'retry_connection' }] };
    await persist(state, { pendingInput: request, status: 'awaiting_connection' });
    emitState(state, 'awaiting_connection', { toolkit });
    return { connectionRequest: request, pendingInput: request, status: 'awaiting_connection' };
  };

  const awaitConnectionNode = async state => {
    interrupt({ run_id: state.runId, ...state.connectionRequest });
    const accounts = await composio.listConnectedAccounts(ctx.orgId);
    const connected = [...new Set(accounts.filter(row => row.status === 'ACTIVE').map(row => row.toolkit).filter(Boolean))];
    emitState(state, 'resumed');
    return { connected, connectionRequest: null, pendingInput: null, status: 'resumed' };
  };

  const discoverNode = async state => {
    const query = state.searchQuery || state.intent?.use_case || message;
    const toolkits = (state.intent?.apps?.length ? state.intent.apps : state.connected).slice(0, 12);
    onEvent({ type: 'tool_start', name: 'COMPOSIO_SEARCH_TOOLS', args: { query } });
    const discovery = await composio.discoverSessionTools(ctx.orgId, { toolkits, useCases: [query], allowDisconnected: true, userId: ctx.userId,
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
    emitState(state, 'capability_discovered');
    return patch;
  };

  const reasonNode = async state => {
    const covered = new Set(state.receipts.filter(row => row.successful).flatMap(row => row.outcome_ids || []));
    if (state.intent.outcomes.every(outcome => covered.has(outcome.id))) return { decision: { action: 'done' }, status: 'ready_to_synthesize' };
    if (state.cycles >= 6) return { decision: { action: 'ask', question: 'I could not find a connected capability that can resolve the remaining information. Please provide that business detail.', fields: ['missing_information'] }, status: 'awaiting_input' };
    const failedSlugs = new Set(state.receipts.filter(row => !row.successful).map(row => row.slug));
    const capabilities = state.capabilities.map(card => ({ slug: card.slug, toolkit: card.toolkit, authority: card.authority,
      description: card.description, required: card.schema.required || [], fields: Object.keys(card.schema.properties || {}),
      attempted_failed: failedSlugs.has(card.slug) }));
    let decision = await jsonDecision(`Act as a self-governing tool agent. Active skill: ${loadGovernedSkill('dependency').content}
Choose one next action: {action:"search"|"read"|"draft"|"ask"|"done",slug?:string,query?:string,purpose?:"outcome"|"prerequisite",outcome_ids?:string[],question?:string,fields?:string[],reason:string}. For read or draft, purpose is required. Use purpose:"outcome" and the unresolved outcome_ids when the capability directly fulfills the request. Use purpose:"prerequisite" and outcome_ids:[] only when its data is required by a later action. Use discovered capabilities before searching again. Never repeat a successful read unless materially different arguments are required. Never ask for provider IDs or account names. A write is only draft. Search queries must be materially new. If the catalog lacks the required reader after two searches, ask for a human-readable business fact or explain the capability gap.`,
      { message, intent: state.intent, capabilities, receipts: state.receipts.map(row => ({ slug: row.slug, successful: row.successful,
        outcome_ids: row.outcome_ids, summary: receiptSummary(row.data) })), prior_searches: state.searchQueries, fields: state.fieldValues }, ctx._signal);
    const viable = capabilities.filter(card => card.authority === 'read' && !card.attempted_failed);
    if (failedSlugs.size && !viable.length && state.searchQueries.length < 3 && ['ask', 'done'].includes(decision.action)) {
      const unresolved = state.intent.outcomes.filter(outcome => !covered.has(outcome.id)).map(outcome => outcome.description).join('; ');
      decision = {
        action: 'search',
        query: `Find a different connected read capability for unresolved outcomes: ${unresolved || state.intent.use_case}. Exclude failed capabilities: ${[...failedSlugs].join(', ')}. Prefer capabilities that list, search, or resolve prerequisite evidence before requiring an identifier.`,
        reason: 'A failed capability cannot justify user clarification while bounded alternative discovery remains',
      };
    }
    const selected = capabilities.find(card => card.slug === decision.slug);
    const invalidAuthority = decision.action === 'read' && selected?.authority !== 'read';
    if (viable.length && (invalidAuthority || (['search', 'ask'].includes(decision.action) && state.searchQueries.length >= 2))) {
      decision = await jsonDecision(`Self-heal a stalled tool plan. Viable read capabilities already exist, so select the best one before asking the user.
Contract: {action:"read"|"ask",slug?:string,purpose?:"outcome"|"prerequisite",outcome_ids?:string[],question?:string,fields?:string[],reason:string}. Choose read when a capability can directly fulfill an outcome or obtain a prerequisite without a technical identifier. Ask only for a human-readable business fact that no capability can obtain.`,
      { message, intent: state.intent, viable_capabilities: viable, successful_receipts: state.receipts.filter(row => row.successful), fields: state.fieldValues }, ctx._signal);
    }
    if (decision.action === 'read' && !viable.some(card => card.slug === decision.slug)) {
      const fallback = bestCapability(viable, state.intent);
      if (fallback) decision = { action: 'read', slug: fallback.slug, purpose: 'outcome',
        outcome_ids: state.intent.outcomes.filter(outcome => !covered.has(outcome.id)).map(outcome => outcome.id), reason: 'Closed-world admissible capability fallback' };
      else decision = state.searchQueries.length < 3
        ? { action: 'search', query: `Find an alternative connected capability for ${state.intent.use_case}`, reason: 'Previously attempted capabilities failed' }
        : { action: 'ask', question: 'The connected integration does not expose a working reader for this request. Please provide the missing business information.', fields: ['missing_information'], reason: 'No admissible capability remains' };
    }
    if (!['search', 'read', 'draft', 'ask', 'done'].includes(decision.action)) throw new Error('governed_action_contract');
    if (['read', 'draft'].includes(decision.action) && !['outcome', 'prerequisite'].includes(decision.purpose)) {
      throw new Error('governed_action_purpose_required');
    }
    if (decision.action === 'search') {
      const prior = new Set(state.searchQueries.map(x => x.toLowerCase()));
      let query = String(decision.query || '').trim();
      if (!query || prior.has(query.toLowerCase())) {
        const unresolved = state.intent.outcomes.filter(outcome => !covered.has(outcome.id)).map(outcome => outcome.description).join('; ');
        query = `Find a connected capability to ${unresolved || state.intent.use_case} using the authenticated ${(state.intent.apps || []).join(', ') || 'account'}`;
      }
      if (!query || prior.has(query.toLowerCase()) || state.searchQueries.length >= 3) {
        return { decision: { action: 'ask', question: 'The connected integration does not expose the reader needed to resolve this automatically. Please provide the missing business information.', fields: ['missing_information'] }, status: 'awaiting_input', cycles: state.cycles + 1 };
      }
      emitState(state, 'dependency_resolved', { next_action: 'discover' });
      return { decision, searchQuery: query.slice(0, 500), cycles: state.cycles + 1, status: 'discovering_dependency' };
    }
    emitState(state, decision.action === 'ask' ? 'awaiting_input' : 'dependency_resolved', { next_action: decision.action });
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
    emitState(state, 'arguments_validated', { tool: card.slug });
    return { toolArgs: args, status: 'arguments_validated' };
  };

  const executeNode = async state => {
    const card = state.capabilities.find(item => item.slug === state.decision.slug);
    const [receipt] = await composio.executeToolsParallel(ctx.orgId, [{ slug: card.slug, arguments: state.toolArgs }],
      { sessionId: state.sessionId, allowDirectFallback: false });
    const unresolved = state.intent.outcomes.map(outcome => outcome.id)
      .filter(id => !state.receipts.some(row => row.successful && row.outcome_ids?.includes(id)));
    const outcomeIds = state.decision.purpose === 'outcome'
      ? (Array.isArray(state.decision.outcome_ids) && state.decision.outcome_ids.length ? state.decision.outcome_ids : unresolved)
      : [];
    const row = { slug: card.slug, successful: receipt?.successful === true, data: compact(receipt?.data, 7000),
      error: receipt?.successful ? null : 'Provider read failed', outcome_ids: outcomeIds };
    const receipts = [...state.receipts, row];
    const steps = [...state.steps, { kind: 'read', slug: card.slug, status: row.successful ? 'completed' : 'error', summary: row.successful ? receiptSummary(receipt.data) : row.error }];
    await persist(state, { receipts, steps, status: row.successful ? 'tool_executed' : 'tool_failed' });
    onEvent({ type: 'tool_result', name: card.slug, status: row.successful ? 'completed' : 'error', summary: steps.at(-1).summary });
    emitState(state, row.successful ? 'tool_executed' : 'tool_failed', { tool: card.slug });
    return { receipts, steps, toolArgs: null, decision: null, status: row.successful ? 'tool_executed' : 'tool_failed' };
  };

  const draftNode = async state => {
    const card = state.capabilities.find(item => item.slug === state.decision.slug);
    const toolArgs = { ...state.toolArgs, _composio_slug: card.slug, _harness_version: 'langgraph-native-v1',
      _graph_thread_id: ctx.governedGraphThreadId, _composio_session_id: state.sessionId, _input_schema: card.schema };
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
    emitState(state, 'awaiting_approval', { approval_id: row.id });
    return patch;
  };

  const approvalNode = async state => {
    const choice = interrupt({ kind: 'approval', run_id: state.runId, approval_id: state.pendingApprovalId,
      prompt: 'Review this draft. Approve to execute it once, or reject it.' });
    const action = String(choice?.action || choice?.value || choice || '').toLowerCase();
    const row = await prisma.pendingWrite.findFirst({ where: { id: state.pendingApprovalId, orgId: ctx.orgId, userId: ctx.userId } });
    if (!row) throw new Error('governed_approval_not_found');
    if (['reject', 'cancel', 'cancelled'].includes(action)) {
      if (row.status === 'draft') await prisma.pendingWrite.updateMany({ where: { id: row.id, status: 'draft' }, data: { status: 'cancelled' } });
      const steps = [...state.steps, { kind: 'approval', slug: row.toolName, status: 'cancelled', summary: 'Draft rejected; nothing sent' }];
      await persist(state, { steps, status: 'completed' });
      emitState(state, 'completed', { approval_id: row.id, approval_status: 'cancelled' });
      return { steps, status: 'done', result: resultShape({ ...state, steps, pendingApprovalId: null }, 'Draft rejected. Nothing was sent.', 'completed') };
    }
    if (action !== 'approve') throw new Error('governed_approval_decision_invalid');
    if (row.status !== 'draft') {
      const summary = row.status === 'sent' ? 'This approved action was already completed.' : `This draft is already ${row.status}.`;
      return { status: row.status === 'sent' ? 'done' : 'failed', result: resultShape(state, summary, row.status === 'sent' ? 'completed' : 'error') };
    }
    const claimed = await prisma.pendingWrite.updateMany({ where: { id: row.id, orgId: ctx.orgId, userId: ctx.userId, status: 'draft',
      expiresAt: { gt: new Date() } }, data: { status: 'approved', approvedAt: new Date() } });
    if (claimed.count !== 1) throw new Error('governed_approval_state_changed');
    const args = { ...(row.toolArgs || {}) };
    for (const key of Object.keys(args)) if (key.startsWith('_')) delete args[key];
    const [receipt] = await composio.executeToolsParallel(ctx.orgId, [{ slug: row.toolName, arguments: args }],
      { sessionId: row.toolArgs?._composio_session_id || state.sessionId, allowDirectFallback: false });
    const successful = receipt?.successful === true;
    const final = await prisma.pendingWrite.update({ where: { id: row.id }, data: { status: successful ? 'sent' : 'failed',
      sentAt: successful ? new Date() : null, result: successful ? compact(receipt.data, 7000) : null,
      errorMsg: successful ? null : String(receipt?.error || 'Provider execution failed').slice(0, 1000) } });
    const steps = [...state.steps, { kind: 'write', slug: row.toolName, status: successful ? 'completed' : 'failed',
      summary: successful ? 'Approved action completed once' : 'Approved action failed' }];
    await persist(state, { steps, status: successful ? 'completed' : 'failed' });
    emitState(state, successful ? 'completed' : 'failed', { approval_id: final.id, approval_status: final.status });
    return { steps, status: successful ? 'done' : 'failed',
      result: resultShape({ ...state, steps }, successful ? 'Approved action completed.' : 'The approved action failed. It was not retried.', successful ? 'completed' : 'error') };
  };

  const humanNode = async state => {
    const request = state.pendingInput || { kind: 'field_input', prompt: humanQuestion(state.decision?.question),
      fields: (state.decision?.fields || ['missing_information']).map(id => ({ id, name: id, label: id.replaceAll('_', ' '), type: 'text', required: true })) };
    await persist(state, { pendingInput: request, status: 'awaiting_input' });
    emitState(state, 'awaiting_input');
    const answer = interrupt({ run_id: state.runId, ...request });
    emitState(state, 'resumed');
    return { fieldValues: { ...state.fieldValues, ...(answer?.values || answer || {}) }, pendingInput: null, decision: null, status: 'resumed' };
  };

  const synthNode = async state => {
    const output = await jsonDecision(`Synthesize the final response in ${state.locale}. Active skill: ${loadGovernedSkill('synthesis').content}
Contract: {response:string}. Use only successful receipts. A successful receipt is authorized evidence: extract and summarize its returned fields directly. Never claim you cannot access data that a successful receipt contains. State genuine capability gaps honestly.`, { message, intent: state.intent, receipts: state.receipts,
      steps: state.steps }, ctx._signal);
    const summary = String(output.response || 'I could not complete the request from available evidence.').slice(0, 5000);
    const status = state.receipts.some(row => row.draft_id) ? 'pending' : 'completed';
    const result = resultShape(state, summary, status);
    await persist(state, { status: status === 'completed' ? 'done' : 'awaiting_approval' });
    emitState(state, status === 'completed' ? 'completed' : 'awaiting_approval');
    return { result, status: status === 'completed' ? 'done' : 'awaiting_approval' };
  };

  const routeReason = state => ({ search: 'discover', read: 'prepare', draft: 'prepare', ask: 'await_human', done: 'synthesize' }[state.decision?.action] || 'synthesize');
  const routePrepared = state => state.decision?.action === 'draft' ? 'draft' : state.decision?.action === 'search' ? 'discover' : 'execute';
  const routeIntent = state => missingApp(state) ? 'prepare_connection' : 'discover';
  const routeConnection = state => missingApp(state) ? 'prepare_connection' : 'discover';
  return new StateGraph(GraphState)
    .addNode('context', contextNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.2 } })
    .addNode('resolve_intent', intentNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.2 } })
    .addNode('prepare_connection', prepareConnectionNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.3 } })
    .addNode('await_connection', awaitConnectionNode)
    .addNode('discover', discoverNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.3 } })
    .addNode('reason', reasonNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.2 } })
    .addNode('prepare', prepareNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.2 } })
    .addNode('execute', executeNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.4 } })
    .addNode('draft', draftNode)
    .addNode('await_approval', approvalNode)
    .addNode('await_human', humanNode)
    .addNode('synthesize', synthNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.2 } })
    .addEdge(START, 'context').addEdge('context', 'resolve_intent')
    .addConditionalEdges('resolve_intent', routeIntent, ['prepare_connection', 'discover'])
    .addEdge('prepare_connection', 'await_connection')
    .addConditionalEdges('await_connection', routeConnection, ['prepare_connection', 'discover'])
    .addConditionalEdges('reason', routeReason, ['discover', 'prepare', 'await_human', 'synthesize'])
    .addConditionalEdges('prepare', routePrepared, ['discover', 'execute', 'draft'])
    .addEdge('discover', 'reason').addEdge('execute', 'reason').addEdge('await_human', 'reason')
    .addEdge('draft', 'await_approval').addEdge('await_approval', END).addEdge('synthesize', END)
    .compile({ checkpointer });
}

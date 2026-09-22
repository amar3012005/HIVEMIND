import crypto from 'node:crypto';
import Ajv from 'ajv';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { chatCompletionFetch, chatCompletionStream, resolveChatSynthesisModel } from '../llm/chat-provider.js';
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
import { decideRuntimeStage, decisionGatewayToolNames } from './decision-gateway-service.js';

export const UNIFIED_META_HARNESS_VERSION = 'langgraph-meta-loop-v2';
const MAX_STEPS = 12;

const State = Annotation.Root({
  runId: Annotation({ reducer: (_left, right) => right, default: () => null }),
  context: Annotation({ reducer: (_left, right) => right, default: () => null }),
  // The plan is a durable, typed routing decision made inside this graph. It
  // constrains the existing model/tool loop; it is never an external router.
  plan: Annotation({ reducer: (_left, right) => right, default: () => null }),
  // Bounded node timings are persisted with the run receipt so latency can be
  // attributed to plan, executor, first visible answer, receipt, and seal.
  timings: Annotation({ reducer: (_left, right) => right, default: () => ({}) }),
  messages: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  receipts: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  steps: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  pendingTool: Annotation({ reducer: (_left, right) => right, default: () => null }),
  // Explicit user writes retain their prepared canonical payload until the
  // in-graph typed plan authorizes the governed save transition.
  pendingSaveDraft: Annotation({ reducer: (_left, right) => right, default: () => null }),
  pendingConnection: Annotation({ reducer: (_left, right) => right, default: () => null }),
  pendingMemoryScope: Annotation({ reducer: (_left, right) => right, default: () => null }),
  pendingApproval: Annotation({ reducer: (_left, right) => right, default: () => null }),
  selectedSlugs: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  primarySlugs: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  schemas: Annotation({ reducer: (_left, right) => right, default: () => ({}) }),
  sessionId: Annotation({ reducer: (_left, right) => right, default: () => null }),
  workflowSessionId: Annotation({ reducer: (_left, right) => right, default: () => null }),
  connectionScope: Annotation({ reducer: (_left, right) => right, default: () => null }),
  requestedToolkits: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  cycles: Annotation({ reducer: (_left, right) => right, default: () => 0 }),
  repairs: Annotation({ reducer: (_left, right) => right, default: () => 0 }),
  callFingerprints: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  result: Annotation({ reducer: (_left, right) => right, default: () => null }),
  usage: Annotation({ reducer: (_left, right) => right, default: () => [] }),
  status: Annotation({ reducer: (_left, right) => right, default: () => 'received' }),
  eventSequence: Annotation({ reducer: (_left, right) => right, default: () => 0 }),
});

const MISSING_SAVE_RESPONSE = 'Tell me the specific fact, decision, or note you want saved, and where it belongs (personal, organization, team, or project).';

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

function explicitDurableSaveRequest(message) {
  const text = String(message || '').toLowerCase();
  return /\b(?:save|store|record|remember|retain|write)\b[\s\S]{0,120}\b(?:memory|hive[-\s]?mind)\b/.test(text);
}

// A completed answer followed by a short imperative such as "save it" is a
// continuation of that answer, not a new recall request.  Keep this narrow:
// it requires a referential save phrase and a prior assistant payload, so a
// standalone request such as "save it for later" still asks for the fact.
function referentialSaveRequest(message) {
  const text = compactText(message, 240).toLowerCase();
  return /^(?:please\s+)?(?:save|store|record|remember|retain|write)\s+(?:it|this|that|the above|the previous(?: answer| response)?|the last(?: answer| response)?)\s*(?:to|in)?\s*(?:hive[-\s]?mind|memory)?[.!]?$/i.test(text);
}

function contextualSaveContinuationRequest(message, history = []) {
  if (!referentialSaveRequest(message)) return false;
  return [...(Array.isArray(history) ? history : [])].reverse()
    .some(row => row?.role === 'assistant' && compactText(row?.content, 8000));
}

function explicitlyRequestedMemoryScope(message) {
  const text = String(message || '').toLowerCase();
  if (/\b(?:personal|private)\s+(?:memory|hive[-\s]?mind)\b/.test(text)) return 'personal';
  if (/\b(?:organization|organisation|company|org(?:-wide)?)\s+(?:memory|hive[-\s]?mind)\b/.test(text)) return 'organization';
  if (/\bteam\s+(?:memory|hive[-\s]?mind)\b/.test(text)) return 'team';
  return null;
}

function explicitSaveDraft(message, history = []) {
  const request = String(message || '').trim();
  if (!explicitDurableSaveRequest(request) && !contextualSaveContinuationRequest(request, history)) return null;
  const inline = request.match(/\b(?:save|store|record|remember|retain|write)\b[\s\S]{0,100}?\b(?:memory|hive[-\s]?mind)\b\s*[:\-]\s*(.+)$/i)?.[1];
  const subject = request.match(/\babout\s+([^,.!?;]+)|\bremember\s+([^,.!?;]+)$/i);
  const namedSubject = compactText(subject?.[1] || subject?.[2] || '', 120);
  const prior = [...(Array.isArray(history) ? history : [])].reverse()
    .find(row => row?.role === 'assistant' && compactText(row?.content, 8000));
  const content = compactText(inline || prior?.content || '', 8000);
  if (!content) return null;
  const tag = namedSubject.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return {
    title: namedSubject ? `${namedSubject} memory` : 'Saved memory',
    content,
    source_type: 'conversation',
    tags: ['user-confirmed', tag || 'conversation'],
    ...(explicitlyRequestedMemoryScope(request) ? { scope: explicitlyRequestedMemoryScope(request) } : {}),
  };
}

function decisionSummaryRequest(message) {
  const text = String(message || '').toLowerCase();
  return /\bdecisions?\b/.test(text)
    && /\b(?:summari[sz]e|recent|latest|list|show|what)\b/.test(text);
}

function systemPrompt({ useTools, locale, explicitSave = false }) {
  return `${ORGANIZATIONAL_BRAIN_PERSONA}

You receive only the progressive gateway capability needed for the current step. Use recent conversation and the compact authenticated profile when sufficient. When available, use hivemind_meta only when organization memory, documents, history, a profile, or a durable save is needed. When available, use hivemind_connected_task for external apps: search once with complete atomic use cases, follow the returned connection state and selected slugs, load only selected schemas, then execute through the same gateway.

Continue after every tool receipt as the same agent. If evidence is incomplete, make the next useful gateway call. Ask the user only for a real business choice that cannot be discovered. Never ask for provider IDs. Never claim that an approval draft was executed. Answer in ${locale || 'the user language'} with concise, well-structured Markdown. Use tables when the user requests multiple records and preserve evidence citations.`;
}

function safeHistory(history = [], limit = 3) {
  return (Array.isArray(history) ? history : []).filter(row => ['user', 'assistant'].includes(row?.role) && row?.content)
    .slice(-limit * 2).map(row => ({ role: row.role, content: compactText(row.content, 1400) }));
}

const PLAN_SYSTEM_CONTRACT = 'Select exactly one intent. The graph, not the decision model, owns authorization, schemas, execution, approvals, receipts, and final synthesis. Do not infer facts or side effects; use only the request, profile, recent turns, and completed governed receipts.';

const MEMORY_CAPSULE_CONTRACT = 'Create a source-grounded memory capsule, not a shallow summary. Use a specific title header identifying the principal subject, event, or decision. Preserve material facts and uncertainty. Capture supported people, organizations, products, places, dates, times, identifiers, amounts, events, relationships, decisions, and source references. Include only details supported by the current request, prior-turn evidence, or governed tool receipts; never invent facts or relationships. Keep authentication codes, passwords, reset links, and sensitive credentials out of memory. Return title, content, tags, entities, dates, source_refs, and scope.';

function executorInstruction(intent, { preparedSave = null } = {}) {
  const contracts = {
    direct_answer: 'Answer directly from the supplied context. Do not call a tool.',
    hivemind_context: 'Use the HIVE meta tool only for authenticated context/profile. Do not perform a write.',
    hivemind_memory_lookup: 'Use the HIVE meta tool for recall with a concrete non-empty query derived from the request. Do not call recall with an omitted query and do not write memory.',
    hivemind_entity_lookup: 'Use the HIVE meta tool to resolve the requested canonical entity before making any broader claim. Do not infer a relationship absent from the receipt.',
    hivemind_hyperagent_directory: 'Use the HIVE meta tool only for authenticated HyperAgent directory/assignment information.',
    hivemind_request: 'Use the typed HIVE meta operation that best matches the request. Keep its arguments grounded in the request and receipts.',
    hivemind_meta: 'Use one read-only HIVE meta operation with complete typed arguments. Never use a blank recall query.',
    hivemind_profile_update: 'Use the governed profile-update tool only for the authenticated user\'s explicit requested field change. Do not treat third-party facts as profile changes.',
    hivemind_save: `${MEMORY_CAPSULE_CONTRACT} Call hivemind_meta once with operation="save" and the capsule in save. If scope is unstated, omit it so the governed scope checkpoint asks the user. Do not call recall as a substitute.`,
    composio_read: 'Use the generic connected-app subgraph: discover capability, select a read tool, load only its schema, compile complete typed arguments, execute, then answer from its receipt. Do not guess a provider-specific tool.',
    composio_action: 'Use the generic connected-app subgraph: discover capability, select tool, load schema, compile arguments, request approval for the write, execute after approval, then answer from its receipt. Never claim an action completed without that receipt.',
    composio_search: 'Use the generic connected-app discovery subgraph first. From discovery decide the actual capability, schema, arguments, approval if needed, execution, and receipt. Do not assume a specific application tool.',
    web_research: 'Use governed web research for current public information. Cite the retrieved evidence and distinguish it from internal HIVE memory.',
    multi_task: 'Preserve every requested outcome. Execute the necessary generic HIVE, connected-app, and/or web steps in dependency order, with a governed receipt for each write or external result.',
    workflow_plan: 'Return an actionable, bounded workflow plan. Do not execute side effects or claim external results.',
    fallback_harness: 'The decision is unavailable or uncertain. Do not call tools. Explain that the request cannot yet be safely routed and ask the smallest clarifying question needed.',
  };
  const prepared = preparedSave ? `\n\nPrepared prior-turn evidence for this save (use only what is supported; improve the generic title and extract supported entities/dates/source references):\n${jsonText(preparedSave).slice(0, 10000)}` : '';
  return `Selected executor intent: ${intent || 'fallback_harness'}.\n${contracts[intent] || contracts.fallback_harness}${prepared}`;
}

function toolkitMentions(message, accounts = []) {
  const request = String(message || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!request) return [];
  return [...new Set((accounts || []).map(row => String(row?.toolkit || '').toLowerCase()).filter(Boolean))]
    .filter(toolkit => {
      const alias = toolkit.replace(/[-_]+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      return alias && (` ${request} `).includes(` ${alias} `);
    });
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

function substantiveProviderReceipt(receipt, primarySlugs = []) {
  if (!receipt || receipt.successful === false || receipt.action !== 'execute'
    || receipt.status === 'schema_loaded_arguments_required' || !primarySlugs.includes(receipt.tool)) return false;
  const data = receipt.data;
  if (data == null) return false;
  const collectionKeys = ['messages', 'items', 'results', 'records', 'emails', 'threads', 'events', 'posts', 'data'];
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data !== 'object') return String(data).trim().length > 0;
  for (const key of collectionKeys) {
    if (Array.isArray(data[key])) return data[key].length > 0;
  }
  return Object.keys(data).some(key => !['nextPageToken', 'next_page_token', 'resultSizeEstimate', 'total', 'count', 'status', 'successful'].includes(key));
}

function substantiveMetaReadReceipt(receipt) {
  if (!receipt || receipt.successful === false || receipt.tool !== 'hivemind_meta') return false;
  if (!['context', 'profiles', 'recall'].includes(String(receipt.action || ''))) return false;
  const data = receipt.data;
  if (data == null) return false;
  if (typeof data !== 'object') return String(data).trim().length > 0;
  return Object.keys(data).length > 0;
}

function invalidFinal(text, receipts) {
  const answer = markdownText(text, 24000);
  if (!answer || /\[object Object\]/.test(answer)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(answer)
    || /(?:^|\s)call:(?:hivemind_|composio_)[a-z0-9_]*\s*\{/i.test(answer)) return true;
  if (!(receipts || []).some(row => row.successful !== false && row.data != null)) return false;
  return /(?:i can(?:not|'t) directly display|i can only confirm|i can show you(?:\.|$)|cannot retrieve the other|need to (?:access|connect to)|please confirm (?:that )?i can proceed|don[’']t have a direct connection)/i.test(answer);
}

// A high-confidence, no-tool JEV decision has already completed the only
// routing step this graph needs.  Sending it through the buffered tool-capable
// model loop would re-plan the turn and withhold every visible token until
// that second inference completes.  These intents have no executor authority
// and can therefore use the receipt-safe final stream immediately.
function isImmediateStreamIntent(plan) {
  if (plan?.authoritative !== true) return false;
  return ['direct_answer', 'workflow_plan', 'fallback_harness'].includes(String(plan.intent || ''));
}

async function defaultModelStep({ messages, tools, model, apiKey, signal }) {
  const primary = resolveChatSynthesisModel(model);
  const fallback = process.env.UNIFIED_META_FALLBACK_MODEL || 'google/gemini-2.5-flash-lite';
  const candidates = [...new Set([primary, fallback])];
  for (let index = 0; index < candidates.length; index += 1) {
    const attemptMessages = index === 0 ? messages : [...messages, {
      role: 'system', content: 'The prior model returned no usable assistant message. Continue the request now using only the available gateway tools or return the final answer.',
    }];
    const toolPayload = Array.isArray(tools) && tools.length ? { tools, tool_choice: 'auto' } : {};
    const response = await chatCompletionFetch(candidates[index], {
      method: 'POST', signal,
      body: JSON.stringify({ temperature: 0, max_tokens: 2400, ...toolPayload, messages: attemptMessages }),
    }, { fallbackApiKey: apiKey, useCase: 'chat', traceId: crypto.randomUUID() });
    if (!response.ok) {
      if (index + 1 < candidates.length) continue;
      throw new Error(`unified_model_http_${response.status}`);
    }
    const payload = await response.json();
    const message = payload?.choices?.[0]?.message;
    if (message && (compactText(message.content) || message.tool_calls?.length)) return { message, usage: payload.usage || null };
  }
  throw new Error('unified_model_empty_choice');
}

/**
 * Stream only the final, receipt-grounded answer. Planning and tool selection
 * remain non-streamed because OpenAI-compatible SSE deltas do not durably
 * expose a complete tool-call contract across all configured providers. At
 * this point there is no further authority decision to make: the answer is
 * synthesized from verified, redacted provider receipts only.
 */
async function defaultFinalStream({ messages, model, apiKey, signal, onDelta }) {
  // The planner's selected model is deliberately carried in `model`, but it
  // is not necessarily a good interactive renderer.  In particular, a
  // reasoning-first planner may stream private reasoning frames and withhold
  // every visible token until it completes.  Final synthesis has no tool
  // authority left: use the deployment-owned final model when supplied so
  // the browser receives the configured visible-token Nitro stream.
  const finalModel = String(process.env.HIVEMIND_AGENT_FINAL_MODEL || '').trim()
    || resolveChatSynthesisModel(model);
  const response = await chatCompletionStream(finalModel, {
    method: 'POST', signal,
    body: JSON.stringify({
      temperature: 0,
      max_tokens: 2400,
      messages,
    }),
  }, {
    fallbackApiKey: apiKey,
    useCase: 'chat_synthesis',
    traceId: crypto.randomUUID(),
    onContent: onDelta,
  });
  if (!response.ok || !compactText(response.content, 1)) {
    throw new Error(`unified_final_stream_${response.status || 'empty'}`);
  }
  return response;
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
  if (operation === 'recall') {
    if (!compactText(args?.recall?.query, 1200)) {
      return {
        successful: false,
        error: 'hivemind_recall_query_required',
        instruction: 'A recall call requires recall.query. If the user asked to save a memory, call hivemind_meta with operation="save" and save.title/save.content instead.',
      };
    }
    return executeGovernedCoreRead('hivemind_recall', recallArgs(args.recall, ctx), ctx);
  }
  if (operation !== 'save') return { successful: false, error: 'hivemind_meta_operation_invalid' };
  const save = args.save || {};
  if (!compactText(save.title, 240) || !compactText(save.content, 8000)) {
    return {
      successful: false,
      error: 'hivemind_save_payload_required',
      instruction: 'A durable save requires a neutral save.title and self-contained save.content. Use the current turn or recent conversation; do not replace this write with recall.',
    };
  }
  const toolArgs = {
    title: save.title, content: save.content,
    tags: Array.isArray(save.tags) && save.tags.length >= 2 ? save.tags : ['hivemind', 'user-confirmed'],
    source_type: save.source_type || 'text',
    ...(Array.isArray(save.entities) ? { entities: save.entities } : {}),
    ...(Array.isArray(save.dates) ? { dates: save.dates } : {}),
    ...(Array.isArray(save.source_refs) ? { source_refs: save.source_refs } : {}),
    ...(save.event_time ? { event_time: save.event_time } : {}),
    ...(save.project ? { project: save.project } : {}),
    // A model must not turn a vague "save this" into an unstated personal
    // or organization write. Scope is user authority, so accept only a
    // destination the user actually named; otherwise let the write handler
    // produce its one durable scope-choice checkpoint.
    ...(explicitlyRequestedMemoryScope(ctx.requestMessage) ? { scope: explicitlyRequestedMemoryScope(ctx.requestMessage) } : {}),
    _memory_admission: 'user_assertion', _require_explicit_scope: true,
  };
  return executeGovernedCoreWrite('hivemind_save_memory', toolArgs, ctx);
}

function workflowId(discovery) {
  return discovery?.workflowSessionId || discovery?.searchResponse?.data?.session?.id || discovery?.session?.id || null;
}

function narrowConnectedSearch(compact, slug) {
  return {
    ...compact,
    results: (compact.results || []).map(row => ({
      ...row,
      primary_tool_slugs: (row.primary_tool_slugs || []).filter(value => value === slug),
      related_tool_slugs: (row.related_tool_slugs || []).filter(value => value === slug),
    })).filter(row => row.primary_tool_slugs.length || row.related_tool_slugs.length),
    decision_selection: { stage: 'composio_selection', selected_tool_slug: slug, authoritative: true },
    next_steps_guidance: `Use only ${slug} for this request. Do not execute any other discovered action.`,
  };
}

async function defaultConnectedExecutor(args, state, ctx, composio, decisionStage = decideRuntimeStage, onDecision = () => {}) {
  const action = String(args.action || '');
  if (action === 'search') {
    const queries = Array.isArray(args.queries) ? args.queries.slice(0, 8) : [];
    if (!queries.length) return { successful: false, error: 'connected_search_queries_required' };
    const requestedTask = compactText(ctx.requestMessage, 1200);
    const useCases = [...new Set([requestedTask, ...queries.map(row => compactText(row?.use_case, 900))].filter(Boolean))].slice(0, 8);
    let toolkits = Array.isArray(args.toolkits) ? args.toolkits.map(value => String(value).toLowerCase()).slice(0, 12) : [];
    let connectionScope = state.connectionScope || ctx.composioConnectionScope || ctx.connectionScope || 'user';
    if (typeof composio.listConnectedAccounts === 'function') {
      const userAccounts = await composio.listConnectedAccounts(ctx.orgId, { userId: ctx.userId, connectionScope });
      const requestText = requestedTask.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
      let active = [...new Set((userAccounts || []).filter(row => row?.status === 'ACTIVE').map(row => String(row.toolkit || '').toLowerCase()).filter(Boolean))];
      const explicitlyNamed = active.filter(toolkit => requestText.includes(toolkit.replace(/[-_]+/g, ' ')));
      if (explicitlyNamed.length) toolkits = explicitlyNamed;
      if (!toolkits.length) toolkits = active.filter(toolkit => requestText.includes(toolkit.replace(/[-_]+/g, ' ')));
      if (!toolkits.length && active.length === 1) toolkits = active;

      // Existing tenants may still own connections under the authenticated
      // organization subject. Prefer user scope, but migrate transparently to
      // org scope when the requested app is active only there.
      if (connectionScope === 'user' && (!explicitlyNamed.length || !toolkits.length || toolkits.some(toolkit => !active.includes(toolkit)))) {
        const orgAccounts = await composio.listConnectedAccounts(ctx.orgId, { userId: ctx.userId, connectionScope: 'org' });
        const orgActive = [...new Set((orgAccounts || []).filter(row => row?.status === 'ACTIVE').map(row => String(row.toolkit || '').toLowerCase()).filter(Boolean))];
        const explicitlyNamedOrg = orgActive.filter(toolkit => requestText.includes(toolkit.replace(/[-_]+/g, ' ')));
        if (explicitlyNamedOrg.length) toolkits = explicitlyNamedOrg;
        if (!toolkits.length) toolkits = orgActive.filter(toolkit => requestText.includes(toolkit.replace(/[-_]+/g, ' ')));
        if (toolkits.length && toolkits.every(toolkit => orgActive.includes(toolkit))) {
          connectionScope = 'org';
          active = orgActive;
        }
      }
    }
    if (!toolkits.length) return {
      successful: false,
      error: 'connected_search_toolkits_required',
      data: { instruction: 'Repeat search with the relevant app/toolkit names inferred from the user request.' },
    };
    const discovery = await composio.discoverSessionTools(ctx.orgId, {
      userId: ctx.userId, connectionScope, toolkits, useCases,
      allowDisconnected: true, sessionId: state.sessionId || null, includeCustomToolkit: false,
      manageConnections: false, hydrateSchemas: false, candidateLimit: 12,
      callbackUrl: ctx.composioCallbackOrigin,
      searchPayload: {
        queries,
        session: args.session || (state.workflowSessionId ? { id: state.workflowSessionId } : { generate_id: true }),
        search_strategy: args.search_strategy || 'auto',
      },
    });
    let compact = compactConnectedSearch(discovery.searchResponse || {
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
    let primarySlugs = [...new Set(discovery.primaryToolSlugs || [])];
    let selectedSlugs = [...new Set([...(discovery.primaryToolSlugs || []), ...(discovery.relatedToolSlugs || [])])];
    // Even one returned provider action still competes with ask/fallback and
    // must be validated against the original request. Jev owns that bounded
    // post-search choice; the existing selector remains the same-turn fallback.
    if (Array.isArray(discovery.tools) && discovery.tools.length > 0) {
      let decision;
      try {
        decision = await decisionStage({
          runtime: 'legacy', stage: 'composio_selection', turn_id: state.runId,
          user_query: ctx.requestMessage, actor_id: ctx.userId, context: state.context,
          discovery: {
            sessionId: discovery.sessionId,
            workflowSessionId: discovery.workflowSessionId,
            tools: discovery.tools,
            toolkitConnectionStatuses: discovery.toolkitConnectionStatuses || {},
          },
          progress: { completed_receipts: state.receipts.slice(-8), selected_tool_slugs: state.selectedSlugs.slice(-12) },
        }, { env: ctx.decisionEnv || process.env, provider: ctx.decisionProvider || null, signal: ctx._signal });
      } catch (error) {
        decision = { status: 'defer', selected: null, authoritative: false,
          receipt: { source: 'fallback', reason: compactText(error?.message || error || 'decision_gateway_unavailable', 240) } };
      }
      onDecision({ stage: 'composio_selection', status: decision.status, selected: decision.selected || null,
        source: decision.receipt?.source || 'fallback', authoritative: decision.authoritative === true,
        probability: decision.receipt?.probability ?? null, margin: decision.receipt?.margin ?? null,
        request_id: decision.receipt?.requestId || null, run_id: state.runId });
      if (decision.status === 'selected' && decision.authoritative === true && String(decision.selected || '').startsWith('use:')) {
        const selected = String(decision.selected).slice(4);
        if (selectedSlugs.includes(selected)) {
          primarySlugs = [selected];
          selectedSlugs = [selected];
          compact = narrowConnectedSearch(compact, selected);
        }
      }
    }
    return {
      successful: true, data: compact,
      state: {
        primarySlugs,
        selectedSlugs,
        sessionId: discovery.sessionId || state.sessionId,
        workflowSessionId: workflowId(discovery) || state.workflowSessionId,
        connectionScope,
      },
      disconnected: disconnectedToolkits(discovery.toolkitConnectionStatuses || compact.toolkit_connection_statuses),
    };
  }
  if (action === 'schemas') {
    const slugs = [...new Set((args.tool_slugs || []).map(String))];
    if (!slugs.length || slugs.some(slug => !state.selectedSlugs.includes(slug))) return { successful: false, error: 'connected_schema_slug_not_selected' };
    if (!state.sessionId) return { successful: false, error: 'connected_session_missing' };
    const schemas = await composio.getSessionToolSchemas(state.sessionId, slugs);
    return { successful: true, data: { tool_schemas: schemas }, state: { schemas: { ...state.schemas, ...schemas } } };
  }
  if (action === 'manage_connection' || action === 'wait_connection') {
    const toolkits = Array.isArray(args.toolkits) ? args.toolkits : [];
    if (!toolkits.length) return { successful: false, error: 'connected_toolkits_required' };
    if (!state.sessionId) return { successful: false, error: 'connected_session_missing' };
    const managed = await composio.manageSessionConnections(state.sessionId, toolkits, { reinitiateAll: action === 'manage_connection' });
    return { successful: true, data: managed, connection: { toolkits, ...managed } };
  }
  if (action !== 'execute') return { successful: false, error: 'connected_action_invalid' };
  const requestedSlug = String(args.tool_slug || '');
  const slug = state.selectedSlugs.find(value => String(value).toLowerCase() === requestedSlug.toLowerCase()) || '';
  if (!slug) return { successful: false, error: 'connected_execute_slug_not_selected' };
  if (!state.sessionId) return { successful: false, error: 'connected_session_missing' };
  let schema = state.schemas[slug];
  let loadedSchemas = {};
  if (!schema?.input_schema) {
    loadedSchemas = await composio.getSessionToolSchemas(state.sessionId, [slug]);
    schema = loadedSchemas?.[slug];
  }
  if (!schema?.input_schema) return { successful: false, error: 'connected_execute_schema_unavailable' };
  const schemaState = Object.keys(loadedSchemas).length ? { schemas: { ...state.schemas, ...loadedSchemas } } : {};
  const suppliedArguments = args.arguments && typeof args.arguments === 'object' ? args.arguments : {};
  if (Object.keys(loadedSchemas).length && Object.keys(schema.input_schema?.properties || {}).length && !Object.keys(suppliedArguments).length) {
    return {
      successful: true,
      status: 'schema_loaded_arguments_required',
      state: schemaState,
      data: {
        tool_slug: slug,
        input_schema: schema.input_schema,
        instruction: 'Bind the original user constraints to this schema, then call execute again with explicit arguments. Do not execute provider defaults.',
      },
    };
  }
  const validate = new Ajv({ strict: false, allErrors: true }).compile(schema.input_schema);
  if (!validate(suppliedArguments)) {
    return { successful: false, error: 'schema_validation_failed', validation_errors: validate.errors?.slice(0, 8) || [] };
  }
  const authority = connectedToolAuthority(slug, schema);
  if (authority === 'write') return { successful: true, state: schemaState, approval: { slug, arguments: suppliedArguments, schema: schema.input_schema } };
  const receipt = (await composio.executeToolsParallel(ctx.orgId, [{ slug, arguments: suppliedArguments }], {
    sessionId: state.sessionId, allowDirectFallback: false,
  }))[0];
  return { ...receipt, state: schemaState, data: publicToolResult(receipt) };
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
      scratch: {
        harness_version: UNIFIED_META_HARNESS_VERSION,
        selected_tool_slugs: state.selectedSlugs,
        workflow_session_id: state.workflowSessionId,
        plan: state.plan ? {
          intent: state.plan.intent,
          source: state.plan.source,
          authoritative: state.plan.authoritative,
          probability: state.plan.probability,
          margin: state.plan.margin,
        } : null,
        timings: state.timings,
      },
    },
    steps: state.steps, sources, citations: sources, draftIds: state.pendingApproval ? [state.pendingApproval.id] : [],
    pendingActions: state.pendingApproval ? [{ id: state.pendingApproval.id }] : [], inputRequests: [], resumeState: null,
    followUps: [], usage: state.usage,
  };
}

function memoryScopeRequest(receipt, runId, preparedSave = null) {
  const data = receipt?.data || receipt || {};
  const scopeOptions = Array.isArray(data.scope_options) ? data.scope_options : [];
  const projects = Array.isArray(data.projects) ? data.projects : [];
  // The checkpoint, not a follow-up model turn, is the authority for a
  // scope-picker continuation. Core may return a normalized draft, while the
  // graph already has the exact user-approved payload and its evidence. Keep
  // both, preferring the original non-empty fields so resuming cannot silently
  // replace the selected memory with a lossy provider draft.
  const returnedDraft = data.draft && typeof data.draft === 'object' ? data.draft : {};
  const originalDraft = preparedSave && typeof preparedSave === 'object' ? preparedSave : {};
  const draft = {
    ...returnedDraft,
    ...originalDraft,
    title: originalDraft.title || returnedDraft.title || null,
    content: originalDraft.content || returnedDraft.content || null,
    tags: Array.isArray(originalDraft.tags) && originalDraft.tags.length ? originalDraft.tags : returnedDraft.tags,
    memory_type: originalDraft.memory_type || returnedDraft.memory_type || 'fact',
    source_refs: Array.isArray(originalDraft.source_refs) ? originalDraft.source_refs : returnedDraft.source_refs,
  };
  return {
    kind: 'memory_scope', run_id: runId, blocking: true,
    prompt: compactText(data.message || 'Choose where this memory belongs before it is saved.', 500),
    draft,
    options: [
      ...scopeOptions.map(option => ({
        id: String(option.scope || option.id || ''), value: String(option.scope || option.id || ''),
        label: String(option.label || option.scope || option.id || ''),
      })).filter(option => option.id),
      ...projects.map(project => ({
        id: `project:${project.id || project.slug || project.name}`,
        value: `project:${project.id || project.slug || project.name}`,
        label: String(project.name || project.slug || 'Project'),
      })),
    ],
  };
}

function savedMemoryAcknowledgement(receipt, scope) {
  const data = receipt?.data || receipt || {};
  const title = compactText(data.title || 'this memory', 160);
  const scopeLabel = scope === 'project' ? 'selected project' : scope;
  // The write receipt is the only synchronous authority. Entity and
  // relationship enrichment is deliberately asynchronous in the canonical
  // ingestion pipeline, so acknowledge the durable save immediately without
  // pretending those derived links have already completed.
  return `Added “${title}” to your ${scopeLabel} company brain. It is durable and searchable now; canonical indexing will connect its people, organizations, dates, and relationships in the background.`;
}

function decisionToolSurface(selection, useTools) {
  const current = unifiedMetaTools({ useTools });
  const names = decisionGatewayToolNames(selection, { connected: useTools });
  if (names === null) return current;
  const constrained = current.filter(tool => names.includes(tool.function.name));
  // The decision taxonomy is shared with other runtimes that expose more
  // native tools. Never turn a valid LangGraph intent into a dead-end merely
  // because this graph has a smaller governed surface.
  return constrained.length || names.length === 0 ? constrained : current;
}

export function createUnifiedMetaAgentGraph({ checkpointer, ctx, message, useTools = false, onEvent = () => {}, composio, prisma, modelStep, finalStream, metaExecutor, connectedExecutor, decisionStage = decideRuntimeStage }) {
  const callModel = modelStep || defaultModelStep;
  // Test seams provide a modelStep; keep those deterministic unless they
  // explicitly inject a finalStream. Production uses the stream by default.
  const streamFinal = finalStream || (!modelStep && ctx.unifiedStreamFinal !== false ? defaultFinalStream : null);
  const runMeta = metaExecutor || defaultMetaExecutor;
  const runConnected = connectedExecutor || defaultConnectedExecutor;
  const ledger = new GovernedAgentEventLedger({ prisma });
  const emitDecision = event => {
    onEvent({ type: 'decision', ...event });
    if (event.source === 'jev' || event.source === 'deterministic') {
      console.info(`[JevDecision] ${JSON.stringify({ runtime: UNIFIED_META_HARNESS_VERSION, ...event })}`);
    }
  };

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
          workflow_session_id: patch.workflowSessionId || state.workflowSessionId || null, selected_tool_slugs: patch.selectedSlugs || state.selectedSlugs || [],
          plan: (patch.plan || state.plan) ? {
            intent: (patch.plan || state.plan).intent,
            source: (patch.plan || state.plan).source,
            authoritative: (patch.plan || state.plan).authoritative,
            probability: (patch.plan || state.plan).probability,
            margin: (patch.plan || state.plan).margin,
          } : null,
          timings: patch.timings || state.timings || {},
          event_sequence: sequence },
      } }).catch(() => {});
    }
    onEvent({ ...safeEventEnvelope({ event: appended.event, runId: state.runId, state: status, sequence }), type: 'agent_state', state: status });
    return { ...patch, status, eventSequence: sequence };
  };

  const contextNode = async state => {
    const runId = state.runId || ctx.unifiedRunId || crypto.randomUUID();
    await ensureRun(runId);
    // A LangGraph thread is durable so an approval can resume its exact
    // checkpoint. It is not a turn cache. Fresh invocations re-enter here,
    // therefore discard the prior turn's executable state before admitting
    // the new request. Conversation and compact receipt context are supplied
    // explicitly through ctx.conversationHistory; a new message must never
    // seal or render an earlier result just because it shares a thread id.
    const freshTurnState = {
      ...state,
      runId,
      context: null,
      plan: null,
      messages: [],
      receipts: [],
      steps: [],
      pendingTool: null,
      pendingConnection: null,
      pendingMemoryScope: null,
      pendingApproval: null,
      selectedSlugs: [],
      primarySlugs: [],
      schemas: {},
      sessionId: null,
      workflowSessionId: null,
      connectionScope: null,
      requestedToolkits: [],
      cycles: 0,
      repairs: 0,
      callFingerprints: [],
      result: null,
      usage: [],
      timings: { admitted_at_ms: Date.now() },
      status: 'received',
      eventSequence: 0,
    };
    let profile = '';
    try { profile = await getSharedProfileStore(prisma).buildCompactProfileContext(ctx.userId, ctx.orgId, ctx.projectId || null); } catch {}
    let requestedToolkits = [];
    if (useTools && typeof composio?.listConnectedAccounts === 'function') {
      const preferredScope = ctx.composioConnectionScope || ctx.connectionScope || 'user';
      const [userAccounts, orgAccounts] = await Promise.all([
        composio.listConnectedAccounts(ctx.orgId, { userId: ctx.userId, connectionScope: preferredScope }).catch(() => []),
        preferredScope === 'org' ? Promise.resolve([]) : composio.listConnectedAccounts(ctx.orgId, { userId: ctx.userId, connectionScope: 'org' }).catch(() => []),
      ]);
      requestedToolkits = toolkitMentions(message, [...userAccounts, ...orgAccounts]);
    }
    const locale = ctx.language || 'en';
    // The direct request and the short follow-up form both feed the same
    // governed write path.  This is capability behavior for every source and
    // agent, not a per-app or per-person exception.
    const explicitSave = explicitDurableSaveRequest(message)
      || referentialSaveRequest(message);
    const saveDraft = explicitSave ? explicitSaveDraft(message, ctx.conversationHistory) : null;
    const messages = [
      { role: 'system', content: systemPrompt({ useTools, locale }) },
      ...(requestedToolkits.length ? [{ role: 'system', content: `The request explicitly names authenticated connected-app toolkit(s): ${requestedToolkits.join(', ')}. External app facts cannot be answered by hivemind_meta. Start or continue hivemind_connected_task search, then follow its connection, schema, and execution receipts before answering.` }] : []),
      ...(profile ? [{ role: 'system', content: `Authenticated compact profile:\n${compactText(profile, 1800)}` }] : []),
      // The plan receives a stable five-turn window. Tool-specific guidance is
      // deliberately withheld until the selected executor node below.
      ...safeHistory(ctx.conversationHistory, 5),
      { role: 'user', content: message },
    ];
    const patch = {
      runId,
      context: {
        locale,
        profile: compactText(profile, 1800),
        system_policy: PLAN_SYSTEM_CONTRACT,
        recent_turns: safeHistory(ctx.conversationHistory, 5),
        explicit_save_language: explicitSave,
      },
      requestedToolkits,
      messages,
      // A prior-answer candidate is evidence for the selected executor, not a
      // bypass around the one JEV plan node or a precompiled tool call.
      pendingSaveDraft: saveDraft,
      timings: { ...freshTurnState.timings, context_ready_at_ms: Date.now() },
      result: null,
    };
    return transition(freshTurnState, 'running', patch, { reason_code: 'turn_admitted' });
  };

  // JEV is deliberately a node *within* LangGraph. It produces a typed plan
  // for this turn, while every subsequent search, schema selection, approval,
  // execution, receipt, and synthesis remains owned by the graph.
  const planNode = async state => {
    let decision;
    try {
      decision = await decisionStage({
        runtime: 'legacy', stage: 'capability', turn_id: state.runId, user_query: message,
        actor_id: ctx.userId,
        context: state.context,
        observation: {
          completed_receipts: state.receipts.slice(-8),
          selected_tool_slugs: state.selectedSlugs.slice(-12),
          prior_receipts: (ctx.priorReceipts || []).slice(-8),
        },
        app_mentions: state.requestedToolkits,
        operational_app_intent: state.requestedToolkits.length > 0,
      }, { env: ctx.decisionEnv || process.env, provider: ctx.decisionProvider || null, signal: ctx._signal });
    } catch (error) {
      decision = { status: 'defer', selected: null, authoritative: false,
        receipt: { source: 'fallback', reason: compactText(error?.message || error || 'decision_gateway_unavailable', 240) } };
    }
    const authoritative = decision.status === 'selected' && decision.authoritative === true;
    const plan = {
      intent: authoritative ? String(decision.selected || 'fallback_harness') : 'fallback_harness',
      authoritative,
      source: decision.receipt?.source || 'fallback',
      probability: decision.receipt?.probability ?? null,
      margin: decision.receipt?.margin ?? null,
      request_id: decision.receipt?.requestId || null,
      reason: decision.receipt?.reason || decision.reason || null,
    };
    emitDecision({ stage: 'capability', status: decision.status, selected: plan.intent,
      source: plan.source, authoritative: plan.authoritative, probability: plan.probability,
      margin: plan.margin, request_id: plan.request_id, run_id: state.runId });
    return { plan, timings: { ...state.timings, plan_completed_at_ms: Date.now() } };
  };

  const modelNode = async state => {
    if (state.cycles >= MAX_STEPS) return { result: outputShape(state, 'I could not safely complete this request within the bounded execution steps.', 'error') };
    const providerEvidenceReady = useTools && state.selectedSlugs.length > 0
      && state.receipts.some(receipt => substantiveProviderReceipt(receipt, state.primarySlugs));
    // Native HIVE reads are already governed and projected before entering the
    // graph. For native-only turns we can stream their final synthesis just as
    // we do connected-app receipts, without streaming an unvalidated planner
    // response or allowing another tool decision mid-stream.
    const metaReadEvidenceReady = !useTools && state.receipts.some(substantiveMetaReadReceipt);
    const finalEvidenceReady = providerEvidenceReady || metaReadEvidenceReady;
    const immediateStream = isImmediateStreamIntent(state.plan);
    const canStreamFinal = (finalEvidenceReady || immediateStream) && streamFinal;
    const finalReceipts = providerEvidenceReady
      ? state.receipts.filter(receipt => substantiveProviderReceipt(receipt, state.primarySlugs))
      : state.receipts.filter(substantiveMetaReadReceipt);
    const modelMessages = finalEvidenceReady ? [
      { role: 'system', content: `Synthesize the final answer from verified governed receipts only. Answer the original request directly in ${ctx.language || 'the user language'} using clear Markdown. Preserve exact names, dates, counts, and uncertainty. Never emit tool syntax or claim facts absent from the receipts.${decisionSummaryRequest(message) ? ' A decision is an explicit choice, approval, commitment, or recorded decision. Do not label an email, calendar event, relationship, or inferred outcome as a decision unless the receipt explicitly supports that classification. Omit unrelated context unless the user requested it.' : ''}` },
      { role: 'user', content: message },
      { role: 'system', content: `Verified receipts:\n${jsonText(finalReceipts).slice(0, 24000)}` },
    ] : [
      ...state.messages,
      { role: 'system', content: executorInstruction(state.plan?.intent, { preparedSave: state.pendingSaveDraft }) },
    ];
    if (canStreamFinal) {
      let emitted = false;
      let firstDeltaAtMs = null;
      const streamed = await streamFinal({
        messages: modelMessages, model: ctx.model, apiKey: ctx._apiKey, signal: ctx._signal,
        onDelta: async delta => {
          const text = String(delta || '');
          if (!text) return;
          if (!emitted) {
            emitted = true;
            firstDeltaAtMs = Date.now();
            onEvent({ type: 'answer_started', schema_version: 1, grounded: finalEvidenceReady, run_id: state.runId });
          }
          // `delta` is the stable chat SSE contract. `text` remains for older
          // consumers that already render the unified-v2 event shape.
          onEvent({ type: 'answer_delta', schema_version: 1, delta: text, text, grounded: finalEvidenceReady, run_id: state.runId });
        },
      });
      const response = markdownText(streamed.content, 24000);
      if (!response) throw new Error('unified_final_stream_empty');
      if (!emitted) {
        firstDeltaAtMs = Date.now();
        onEvent({ type: 'answer_started', schema_version: 1, grounded: finalEvidenceReady, run_id: state.runId });
      }
      onEvent({ type: 'answer_completed', schema_version: 1, grounded: finalEvidenceReady, run_id: state.runId });
      return {
        messages: [...state.messages, { role: 'assistant', content: response }],
        pendingTool: null,
        usage: streamed.usage ? [...state.usage, streamed.usage] : state.usage,
        timings: { ...state.timings, first_answer_delta_at_ms: state.timings.first_answer_delta_at_ms || firstDeltaAtMs || Date.now(), completion_at_ms: Date.now() },
        result: outputShape({ ...state, usage: streamed.usage ? [...state.usage, streamed.usage] : state.usage,
          timings: { ...state.timings, first_answer_delta_at_ms: state.timings.first_answer_delta_at_ms || firstDeltaAtMs || Date.now(), completion_at_ms: Date.now() } }, response),
      };
    }
    // Reuse the plan-node decision for every model pass in this turn. In
    // particular, a tool receipt must not trigger a second capability model
    // call; later Composio selection is a separate bounded decision over the
    // dynamically discovered provider tools.
    const tools = providerEvidenceReady ? []
      : decisionToolSurface(state.plan?.intent || 'fallback_harness', useTools);
    const turn = await callModel({
      messages: modelMessages, tools, model: ctx.model,
      apiKey: ctx._apiKey, signal: ctx._signal, state,
    });
    const assistant = turn.message || turn;
    const usage = turn.usage ? [...state.usage, turn.usage] : state.usage;
    const messages = [...state.messages, { role: 'assistant', content: assistant.content || null, ...(assistant.tool_calls?.length ? { tool_calls: assistant.tool_calls } : {}) }];
    const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    if (calls.length) return { messages, pendingTool: parseUnifiedToolCall(calls[0]), cycles: state.cycles + 1, usage };
    const connectedDiscoveryMissing = useTools && state.requestedToolkits.length > 0 && state.selectedSlugs.length === 0;
    const connectedExecutionMissing = useTools && state.selectedSlugs.length > 0
      && !state.receipts.some(receipt => substantiveProviderReceipt(receipt, state.primarySlugs));
    if ((connectedDiscoveryMissing || connectedExecutionMissing || invalidFinal(assistant.content, state.receipts)) && state.repairs < 3) {
      return {
        messages: [...messages, { role: 'system', content: connectedDiscoveryMissing
          ? `The original request names connected toolkit(s) (${state.requestedToolkits.join(', ')}), but no connected-app discovery receipt exists. Call hivemind_connected_task with action search now. Do not answer from hivemind_meta or claim that external access is unavailable.`
          : state.selectedSlugs.length
          ? `Do not ask permission for a read or describe what you could do. Continue the connected workflow now: load schemas for the selected slugs (${state.selectedSlugs.join(', ')}), execute the required read, then answer from its receipt.`
          : 'Your proposed answer did not present the successful receipt evidence. Continue with the available gateway tools, then answer the original request directly from the receipts.' }],
        pendingTool: null, cycles: state.cycles + 1, repairs: state.repairs + 1, usage,
      };
    }
    if (connectedDiscoveryMissing || connectedExecutionMissing) {
      return { messages, pendingTool: null, usage, result: outputShape({ ...state, messages, usage }, 'I could not safely complete the connected task because no provider result was produced.', 'error') };
    }
    const response = markdownText(assistant.content, 24000);
    onEvent({ type: 'answer_started', schema_version: 1, grounded: finalEvidenceReady, run_id: state.runId });
    onEvent({ type: 'answer_delta', schema_version: 1, delta: response, text: response, grounded: finalEvidenceReady, run_id: state.runId });
    onEvent({ type: 'answer_completed', schema_version: 1, grounded: finalEvidenceReady, run_id: state.runId });
    return { messages, pendingTool: null, usage,
      timings: { ...state.timings, first_answer_delta_at_ms: state.timings.first_answer_delta_at_ms || Date.now(), completion_at_ms: Date.now() },
      result: outputShape({ ...state, messages, usage,
        timings: { ...state.timings, first_answer_delta_at_ms: state.timings.first_answer_delta_at_ms || Date.now(), completion_at_ms: Date.now() } }, response) };
  };

  const toolNode = async state => {
    const call = state.pendingTool;
    const fingerprint = crypto.createHash('sha256').update(`${call.name}:${jsonText(call.args)}`).digest('hex');
    if (state.callFingerprints.includes(fingerprint)) {
      const receipt = { tool: call.name, successful: false, error: 'identical_tool_call_already_completed' };
      return { pendingTool: null, messages: [...state.messages, toolMessage(call, receipt)], receipts: [...state.receipts, receipt] };
    }
    onEvent({ type: 'tool_start', name: call.name, arguments: call.args, run_id: state.runId });
    const executorTimings = { ...state.timings, executor_started_at_ms: state.timings.executor_started_at_ms || Date.now() };
    if (call.name === '__invalid_tool__') {
      const receipt = {
        successful: false,
        error: 'tool_not_available',
        requested_tool: compactText(call.requestedName, 120),
        available_tools: unifiedMetaTools({ useTools }).map(tool => tool.function.name),
        instruction: 'Choose one available gateway tool and continue the original request.',
      };
      onEvent({ type: 'tool_result', name: call.requestedName || call.name, status: 'error', summary: receipt.error, run_id: state.runId });
      return {
        pendingTool: null,
        timings: executorTimings,
        callFingerprints: [...state.callFingerprints, fingerprint],
        messages: [...state.messages, toolMessage(call, receipt)],
        receipts: [...state.receipts, { tool: call.requestedName || call.name, successful: false, data: receipt, error: receipt.error }],
        steps: [...state.steps, { kind: 'tool', slug: call.requestedName || call.name, status: 'error', summary: receipt.error }],
      };
    }
    let receipt = call.name === 'hivemind_meta'
      ? await runMeta(call.args, ctx, state)
      : await runConnected(call.args, state, ctx, composio, decisionStage, emitDecision);
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
      return transition(state, 'awaiting_approval', { ...patch, timings: { ...executorTimings, receipt_at_ms: Date.now() } }, { tool_slug: receipt.tool_slug, reason_code: 'write_approval_required' });
    }
    if (call.name === 'hivemind_meta' && call.args.operation === 'save'
      && receipt?.successful === false && receipt?.error === 'hivemind_save_payload_required') {
      const response = 'Tell me the specific fact, decision, or note you want saved, and where it belongs (personal, organization, team, or project).';
      const receipts = [...state.receipts, { tool: call.name, action: 'save', successful: false, error: receipt.error, data: null }];
      return {
        pendingTool: null,
        callFingerprints: [...state.callFingerprints, fingerprint],
        messages: [...state.messages, toolMessage(call, receipt)],
        receipts,
        steps: [...state.steps, { kind: 'memory_scope', slug: 'hivemind_save_memory', status: 'needs_input', summary: response }],
        result: outputShape({ ...state, receipts }, response, 'needs_input'),
      };
    }
    if (call.name === 'hivemind_meta' && call.args.operation === 'save' && receipt?.data?.needs_project_choice) {
      const request = memoryScopeRequest(receipt, state.runId, call.args?.save);
      const patch = {
        ...statePatch, pendingTool: null, pendingMemoryScope: request,
        callFingerprints: [...state.callFingerprints, fingerprint],
        messages: [...state.messages, toolMessage(call, receipt)],
        receipts: [...state.receipts, { tool: call.name, action: 'save', successful: true, data: receipt.data }],
        steps: [...state.steps, { kind: 'memory_scope', slug: 'hivemind_save_memory', status: 'waiting', summary: request.prompt }],
      };
      return transition(state, 'awaiting_input', { ...patch, timings: { ...executorTimings, receipt_at_ms: Date.now() } }, { tool_slug: 'hivemind_save_memory', reason_code: 'memory_scope_required' });
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
      return transition(state, 'awaiting_input', { ...patch, timings: { ...executorTimings, receipt_at_ms: Date.now() } }, { tool_slug: toolkits[0], reason_code: 'connection_required' });
    }
    const exposed = publicToolResult(receipt);
    const underlying = call.name === 'hivemind_connected_task' && call.args.action === 'execute' ? call.args.tool_slug : call.name;
    onEvent({ type: 'tool_result', name: underlying, status: receipt?.successful === false ? 'error' : 'completed', summary: receipt?.error || 'Completed', run_id: state.runId });
    // A completed governed memory write is authoritative regardless of the
    // wording that led to it. Seal the receipt directly; never re-enter a
    // model/retrieval loop after any successful save.
    if (call.name === 'hivemind_meta' && call.args.operation === 'save'
      && receipt?.successful !== false) {
      const receipts = [...state.receipts, {
        tool: underlying, action: 'save', status: receipt?.status || null,
        successful: true, data: exposed, error: null,
      }];
      const steps = [...state.steps, { kind: 'tool', slug: underlying, status: 'completed', summary: 'Memory saved' }];
      const response = savedMemoryAcknowledgement(receipt, receipt?.data?.scope || call.args?.save?.scope || 'personal');
      onEvent({ type: 'answer_started', schema_version: 1, grounded: true, run_id: state.runId });
      onEvent({ type: 'answer_delta', schema_version: 1, delta: response, text: response, grounded: true, run_id: state.runId });
      onEvent({ type: 'answer_completed', schema_version: 1, grounded: true, run_id: state.runId });
      return {
        pendingTool: null,
        pendingSaveDraft: null,
        callFingerprints: [...state.callFingerprints, fingerprint],
        messages: [...state.messages, toolMessage(call, exposed), { role: 'assistant', content: response }],
        receipts,
        steps,
        timings: { ...executorTimings, receipt_at_ms: Date.now(), first_answer_delta_at_ms: Date.now(), completion_at_ms: Date.now() },
        result: outputShape({ ...state, pendingTool: null, pendingSaveDraft: null, receipts, steps,
          timings: { ...executorTimings, receipt_at_ms: Date.now(), first_answer_delta_at_ms: Date.now(), completion_at_ms: Date.now() } }, response),
      };
    }
    return {
      ...statePatch, pendingTool: null, timings: { ...executorTimings, receipt_at_ms: Date.now() }, callFingerprints: [...state.callFingerprints, fingerprint],
      messages: [...state.messages, toolMessage(call, exposed)],
      receipts: [...state.receipts, {
        tool: underlying,
        action: call.name === 'hivemind_connected_task' ? call.args.action
          : (call.name === 'hivemind_meta' ? call.args.operation : null),
        status: receipt?.status || null,
        successful: receipt?.successful !== false,
        data: exposed,
        error: receipt?.error || null,
      }],
      steps: [...state.steps, { kind: 'tool', slug: underlying, status: receipt?.successful === false ? 'error' : 'completed', summary: receipt?.error || 'Completed' }],
    };
  };

  const connectionNode = async state => {
    interrupt({ run_id: state.runId, ...state.pendingConnection });
    const accounts = await composio.listConnectedAccounts(ctx.orgId, { userId: ctx.userId, connectionScope: state.connectionScope || ctx.composioConnectionScope || ctx.connectionScope || 'user' });
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
      receipts: [...state.receipts, { tool: row.toolName, action: 'execute', status: successful ? 'executed' : 'failed', successful, data: exposed, error: receipt?.error || null }],
      steps: [...state.steps, { kind: 'approval', slug: row.toolName, status: successful ? 'completed' : 'failed', summary: successful ? 'Approved action completed once' : 'Approved action failed' }],
    };
  };

  const memoryScopeNode = async state => {
    const request = state.pendingMemoryScope;
    const choice = interrupt(request);
    const raw = compactText(choice?.scope || choice?.value || choice, 300);
    const selected = raw.toLowerCase();
    const draft = request?.draft || {};
    const saveArgs = {
      title: draft.title,
      content: draft.content,
      tags: Array.isArray(draft.tags) && draft.tags.length >= 2 ? draft.tags : ['hivemind', 'user-confirmed'],
      memory_type: draft.memory_type || 'fact',
      ...(Array.isArray(draft.entities) ? { entities: draft.entities } : {}),
      ...(Array.isArray(draft.dates) ? { dates: draft.dates } : {}),
      ...(Array.isArray(draft.source_refs) ? { source_refs: draft.source_refs } : {}),
      ...(draft.event_time ? { event_time: draft.event_time } : {}),
      _memory_admission: 'user_assertion', _require_explicit_scope: true,
    };
    if (['personal', 'organization', 'team'].includes(selected)) saveArgs.scope = selected;
    else if (selected.startsWith('project:') && raw.slice('project:'.length).trim()) {
      saveArgs.scope = 'project';
      saveArgs.project = raw.slice('project:'.length).trim();
    } else {
      throw new Error('unified_memory_scope_invalid');
    }
    onEvent({ type: 'tool_start', name: 'hivemind_save_memory', arguments: saveArgs, run_id: state.runId });
    const receipt = await executeGovernedCoreWrite('hivemind_save_memory', saveArgs, ctx);
    if (receipt?.successful === false || receipt?.data?.saved !== true) {
      onEvent({ type: 'tool_result', name: 'hivemind_save_memory', status: 'error', summary: receipt?.error || receipt?.data?.error || 'Memory save failed', run_id: state.runId });
      throw new Error(`unified_memory_scope_save_failed:${compactText(receipt?.error || receipt?.data?.error || 'unknown', 160)}`);
    }
    const exposed = publicToolResult(receipt);
    const response = savedMemoryAcknowledgement(receipt, saveArgs.scope);
    const receipts = [...state.receipts, { tool: 'hivemind_save_memory', action: 'save', successful: true, data: exposed }];
    const steps = [...state.steps, { kind: 'memory_scope', slug: 'hivemind_save_memory', status: 'completed', summary: 'Memory saved in selected scope' }];
    onEvent({ type: 'tool_result', name: 'hivemind_save_memory', status: 'completed', summary: 'Memory saved in selected scope', run_id: state.runId });
    onEvent({ type: 'answer_started', schema_version: 1, grounded: true, run_id: state.runId });
    onEvent({ type: 'answer_delta', schema_version: 1, delta: response, text: response, grounded: true, run_id: state.runId });
    onEvent({ type: 'answer_completed', schema_version: 1, grounded: true, run_id: state.runId });
    return {
      pendingMemoryScope: null,
      messages: [...state.messages, { role: 'system', content: jsonText({ memory_save: 'completed', receipt: exposed }) }, { role: 'assistant', content: response }],
      receipts,
      steps,
      timings: { ...state.timings, executor_started_at_ms: state.timings.executor_started_at_ms || Date.now(), receipt_at_ms: Date.now(), first_answer_delta_at_ms: Date.now(), completion_at_ms: Date.now() },
      result: outputShape({ ...state, pendingMemoryScope: null, receipts, steps,
        timings: { ...state.timings, executor_started_at_ms: state.timings.executor_started_at_ms || Date.now(), receipt_at_ms: Date.now(), first_answer_delta_at_ms: Date.now(), completion_at_ms: Date.now() } }, response),
    };
  };

  const routeModel = state => state.result ? 'seal' : (state.pendingTool ? 'tool' : 'model');
  const routeContext = state => state.result ? 'seal' : (state.pendingTool ? 'tool' : 'classify_plan');
  const routePlan = state => state.result ? 'seal' : (state.pendingTool ? 'tool' : 'model');
  const routeTool = state => state.result ? 'seal' : (state.pendingConnection ? 'connection' : (state.pendingMemoryScope ? 'memory_scope' : (state.pendingApproval ? 'approval' : 'model')));
  const routeConnection = state => state.pendingConnection ? 'connection' : 'model';
  const routeMemoryScope = state => state.result ? 'seal' : 'model';
  const sealNode = async state => {
    onEvent({ type: 'finish', text: state.result.response });
    const terminalState = state.result.status === 'completed' ? 'sealed'
      : state.result.status === 'needs_input' ? 'awaiting_input' : 'failed';
    return transition(state, terminalState, {}, { reason_code: state.result.status });
  };

  return new StateGraph(State)
    .addNode('admit_context', contextNode)
    .addNode('classify_plan', planNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.15 } })
    .addNode('model', modelNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.2 } })
    .addNode('tool', toolNode, { retryPolicy: { maxAttempts: 2, initialInterval: 0.3 } })
    .addNode('connection', connectionNode)
    .addNode('memory_scope', memoryScopeNode)
    .addNode('approval', approvalNode)
    .addNode('seal', sealNode)
    .addEdge(START, 'admit_context')
    .addConditionalEdges('admit_context', routeContext, ['classify_plan', 'tool', 'seal'])
    .addConditionalEdges('classify_plan', routePlan, ['model', 'tool', 'seal'])
    .addConditionalEdges('model', routeModel, ['model', 'tool', 'seal'])
    .addConditionalEdges('tool', routeTool, ['model', 'connection', 'memory_scope', 'approval', 'seal'])
    .addConditionalEdges('connection', routeConnection, ['connection', 'model'])
    .addConditionalEdges('memory_scope', routeMemoryScope, ['model', 'seal'])
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

export async function runUnifiedMetaAgent({ message, useTools = false, ctx = {}, onEvent, prisma = null, composio = null, choice = null, graph = null, checkpointer = null, modelStep = null, finalStream = null, metaExecutor = null, connectedExecutor = null, decisionStage = decideRuntimeStage } = {}) {
  const db = prisma || ctx.prisma;
  if (!db) throw new Error('unified_prisma_required');
  const connector = composio || await import('../connectors/composio/composio-service.js');
  const graphThreadId = threadId(ctx);
  const runId = ctx.unifiedRunId || choice?.run_id || crypto.randomUUID();
  const runtimeCtx = { ...ctx, prisma: db, requestMessage: message, unifiedRunId: runId, unifiedGraphThreadId: graphThreadId };
  const runtime = graph || createUnifiedMetaAgentGraph({ checkpointer: checkpointer || await productionCheckpointer(), ctx: runtimeCtx, message, useTools, onEvent, composio: connector, prisma: db, modelStep, finalStream, metaExecutor, connectedExecutor, decisionStage });
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

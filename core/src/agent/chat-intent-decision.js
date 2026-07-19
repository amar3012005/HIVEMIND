/**
 * Language-agnostic chat intent parser.
 *
 * Intent is model-parsed through one required structured tool call. There are
 * deliberately no word lists, locale regexes, filename regexes, or imperative
 * phrase fallbacks in this module. A parser outage fails safely to scoped
 * recall of the unchanged user message.
 */

const CHAT_INTENT_VERSION = 'chat-intent.v2';
const OPERATIONS = new Set([
  'direct', 'recall', 'source_read', 'aggregate', 'connector_read',
  'connector_write', 'save', 'update', 'delete', 'rename_assistant',
]);
const RECALL_MODES = new Set(['fact', 'explain', 'full']);
const SCOPES = new Set(['personal', 'project', 'team', 'organization']);
const SIDE_EFFECT_POLICIES = new Set(['read_only', 'approval_required']);

function boundedText(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function boundedStrings(value, maxItems = 12, maxLength = 512) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim())
      .slice(0, maxItems).map((item) => item.trim().slice(0, maxLength))
    : [];
}

export function normalizeChatHistory(history, limit = 6) {
  return (Array.isArray(history) ? history : [])
    .filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant') && turn.content)
    .slice(-limit)
    .map((turn) => ({ role: turn.role, content: boundedText(turn.content, 800) }));
}

export function createChatIntentTool(groupCatalog = []) {
  const groupNames = groupCatalog.map((group) => group.name).filter(Boolean);
  return {
    type: 'function',
    function: {
      name: 'route_chat_turn',
      description: 'Classify the complete chat turn and select the minimum tool groups required. Preserve the user language, exact entity names, and exact source titles.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operation: { type: 'string', enum: [...OPERATIONS] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          response_language: { type: 'string', description: 'BCP-47 language tag inferred from the request and history.' },
          direct_response: { type: 'string', description: 'Same-language response. Required only for direct.' },
          queries: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          named_entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          recall_mode: { type: 'string', enum: [...RECALL_MODES] },
          source: {
            type: 'object', additionalProperties: false,
            properties: { document_id: { type: 'string' }, title: { type: 'string' } },
          },
          aggregate: {
            type: 'object', additionalProperties: false,
            properties: { parent: { type: 'string' }, kind: { type: 'string' } },
            required: ['parent', 'kind'],
          },
          tool_groups: {
            type: 'array', uniqueItems: true,
            items: groupNames.length ? { type: 'string', enum: groupNames } : { type: 'string' },
          },
          connector_provider: { type: 'string' },
          scope_filter: { type: 'string', enum: [...SCOPES] },
          side_effect_policy: { type: 'string', enum: [...SIDE_EFFECT_POLICIES] },
          save: {
            type: 'object', additionalProperties: false,
            properties: {
              title: { type: 'string' }, content: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' }, maxItems: 12 },
              memory_type: { type: 'string' }, project_hint: { type: 'string' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['title', 'content'],
          },
          update: {
            type: 'object', additionalProperties: false,
            properties: { id: { type: 'string' }, content: { type: 'string' }, title: { type: 'string' }, reason: { type: 'string' } },
          },
          delete: {
            type: 'object', additionalProperties: false,
            properties: { id: { type: 'string' }, reason: { type: 'string' } },
            required: ['id'],
          },
          time: {
            type: 'object', additionalProperties: false,
            properties: {
              valid_at: { type: 'string' }, known_at: { type: 'string' },
              range: {
                type: 'object', additionalProperties: false,
                properties: { start: { type: 'string' }, end: { type: 'string' } },
              },
            },
          },
          continuation: {
            type: 'object', additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['project_choice'] },
              project_hint: { type: 'string' }, selected_scope: { type: 'string', enum: [...SCOPES] },
            },
          },
          assistant_name: { type: 'string' },
          project_prompt: { type: 'string', description: 'Same-language question to ask if memory scope is unresolved.' },
          acknowledgement: { type: 'string', description: 'Same-language acknowledgement for a successful save, mutation, or connector write.' },
          failure_response: { type: 'string', description: 'Same-language response if the selected operation or toolkit cannot be executed safely.' },
        },
        required: ['operation', 'confidence', 'response_language', 'queries', 'named_entities', 'recall_mode', 'tool_groups', 'side_effect_policy'],
      },
    },
  };
}

function safeRecallDecision({ message, language, reason }) {
  return {
    version: CHAT_INTENT_VERSION,
    operation: 'recall', confidence: 0,
    response_language: boundedText(language, 32) || 'und',
    direct_response: '', queries: [boundedText(message)], named_entities: [],
    recall_mode: 'fact', source: null, aggregate: null, tool_groups: ['hivemind-recall'],
    connector_provider: null, scope_filter: null, side_effect_policy: 'read_only',
    save: null, update: null, delete: null, time: null, continuation: null,
    assistant_name: null, project_prompt: '', acknowledgement: '', failure_response: '',
    parser_fallback: reason || 'intent_parser_unavailable',
  };
}

export function normalizeIntentDecision(raw, { message, language, allowedGroups = [] } = {}) {
  if (!raw || typeof raw !== 'object' || !OPERATIONS.has(raw.operation)) {
    return safeRecallDecision({ message, language, reason: 'invalid_intent_payload' });
  }
  const allowed = new Set(allowedGroups);
  const operation = raw.operation;
  const sideEffect = operation === 'connector_write' || operation === 'delete'
    ? 'approval_required'
    : (SIDE_EFFECT_POLICIES.has(raw.side_effect_policy) ? raw.side_effect_policy : 'read_only');
  const queries = boundedStrings(raw.queries, 3, 1000);
  if (operation !== 'direct' && queries.length === 0 && !['save', 'update', 'delete', 'rename_assistant'].includes(operation)) {
    queries.push(boundedText(message));
  }
  const source = raw.source && (boundedText(raw.source.document_id, 128) || boundedText(raw.source.title, 512))
    ? { document_id: boundedText(raw.source.document_id, 128) || null, title: boundedText(raw.source.title, 512) || null }
    : null;
  const aggregate = raw.aggregate && boundedText(raw.aggregate.parent, 256) && boundedText(raw.aggregate.kind, 128)
    ? { parent: boundedText(raw.aggregate.parent, 256), kind: boundedText(raw.aggregate.kind, 128), requires_complete_coverage: true }
    : null;
  const toolGroups = boundedStrings(raw.tool_groups, 12, 128).filter((name) => allowed.has(name));
  const requiredNativeGroup = ['recall', 'source_read', 'aggregate'].includes(operation)
    ? 'hivemind-recall'
    : ['save', 'update', 'delete', 'rename_assistant'].includes(operation) ? 'hivemind-memory-write' : null;
  if (requiredNativeGroup && allowed.has(requiredNativeGroup) && !toolGroups.includes(requiredNativeGroup)) {
    toolGroups.push(requiredNativeGroup);
  }
  const normalized = {
    version: CHAT_INTENT_VERSION,
    operation,
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
    response_language: boundedText(raw.response_language, 32) || boundedText(language, 32) || 'und',
    direct_response: boundedText(raw.direct_response, 2000),
    queries,
    named_entities: boundedStrings(raw.named_entities, 12, 256),
    recall_mode: RECALL_MODES.has(raw.recall_mode) ? raw.recall_mode : 'fact',
    source,
    aggregate,
    tool_groups: toolGroups,
    connector_provider: boundedText(raw.connector_provider, 128) || null,
    scope_filter: SCOPES.has(raw.scope_filter) ? raw.scope_filter : null,
    side_effect_policy: sideEffect,
    save: raw.save && boundedText(raw.save.content)
      ? {
          title: boundedText(raw.save.title, 200), content: boundedText(raw.save.content),
          tags: boundedStrings(raw.save.tags, 12, 128), memory_type: boundedText(raw.save.memory_type, 64) || 'fact',
          project_hint: boundedText(raw.save.project_hint, 256) || null,
          confidence: Math.max(0, Math.min(1, Number(raw.save.confidence) || 0)),
        }
      : null,
    update: raw.update && boundedText(raw.update.id, 128)
      ? { id: boundedText(raw.update.id, 128), content: boundedText(raw.update.content), title: boundedText(raw.update.title, 200), reason: boundedText(raw.update.reason, 500) }
      : null,
    delete: raw.delete && boundedText(raw.delete.id, 128)
      ? { id: boundedText(raw.delete.id, 128), reason: boundedText(raw.delete.reason, 500) }
      : null,
    time: raw.time ? {
      valid_at: boundedText(raw.time.valid_at, 64) || null,
      known_at: boundedText(raw.time.known_at, 64) || null,
      range: raw.time.range ? { start: boundedText(raw.time.range.start, 64) || null, end: boundedText(raw.time.range.end, 64) || null } : null,
    } : null,
    continuation: raw.continuation?.kind === 'project_choice'
      ? { kind: 'project_choice', project_hint: boundedText(raw.continuation.project_hint, 256) || null, selected_scope: SCOPES.has(raw.continuation.selected_scope) ? raw.continuation.selected_scope : null }
      : null,
    assistant_name: boundedText(raw.assistant_name, 80) || null,
    project_prompt: boundedText(raw.project_prompt, 1000),
    acknowledgement: boundedText(raw.acknowledgement, 1000),
    failure_response: boundedText(raw.failure_response, 1000),
  };
  const invalid =
    (operation === 'direct' && !normalized.direct_response)
    || (operation === 'source_read' && !normalized.source)
    || (operation === 'aggregate' && !normalized.aggregate)
    || (operation === 'connector_read' && (!normalized.connector_provider || normalized.tool_groups.length === 0))
    || (operation === 'connector_write' && (!normalized.connector_provider || normalized.tool_groups.length === 0))
    || (operation === 'save' && !normalized.save)
    || (operation === 'update' && !normalized.update)
    || (operation === 'delete' && !normalized.delete)
    || (operation === 'rename_assistant' && !normalized.assistant_name)
    || (['connector_read', 'connector_write'].includes(operation) && !normalized.failure_response)
    || (['connector_write', 'save', 'update', 'delete', 'rename_assistant'].includes(operation) && !normalized.acknowledgement)
    || (operation === 'save' && !normalized.project_prompt);
  return invalid ? safeRecallDecision({ message, language, reason: 'invalid_intent_combination' }) : normalized;
}

export async function parseChatIntent({
  message, language = null, history = [], groupCatalog = [], model, apiKey,
  signal, fetchImpl = globalThis.fetch,
} = {}) {
  const allowedGroups = groupCatalog.map((group) => group.name).filter(Boolean);
  const catalog = groupCatalog.map((group) => ({
    name: boundedText(group.name, 128),
    description: boundedText(group.description, 300),
    tools: (group.tools || []).slice(0, 24).map((tool) => ({
      name: boundedText(tool.name, 128),
      description: boundedText(tool.description, 240),
      read_only: tool.readOnly === true,
    })),
  }));
  const system = `You are the fast intent and capability parser for a multi-tenant enterprise assistant.
Return exactly one route_chat_turn tool call. Understand the user's language directly; do not translate exact names, filenames, identifiers, or search queries.
Use the conversation history to resolve references. Select the minimum tool groups whose descriptions match the request.
Use source_read for a named source/file, aggregate for exhaustive count/list requests, connector_read for current connected-app data, and connector_write only for an explicit external side effect.
Return explicit ISO time fields when the request is temporal; do not make downstream code infer dates from words.
Use save only for an explicit save request or a high-confidence durable fact about the user's own world. Put the fully resolved fact in save.content; never return a pronoun or the save instruction itself.
When the prior assistant requested a project choice, resolve it through continuation instead of copying the prior prompt text.
Use scope_filter=personal for questions specifically about the user. Writes require approval. Never broaden organization or project scope.
For direct conversational replies, supply direct_response in the user's language.
For connector operations, supply failure_response in the user's language for a safe execution failure. For connector_write also supply acknowledgement.
Available tool groups:\n${JSON.stringify(catalog)}`;
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      ...normalizeChatHistory(history),
      { role: 'user', content: boundedText(message, 6000) },
    ],
    tools: [createChatIntentTool(groupCatalog)],
    tool_choice: { type: 'function', function: { name: 'route_chat_turn' } },
    temperature: 0,
    max_tokens: 650,
  };
  const parserController = new AbortController();
  const timeout = setTimeout(() => parserController.abort(), Number(process.env.CHAT_INTENT_TIMEOUT_MS || 1500));
  if (signal) {
    if (signal.aborted) parserController.abort();
    else signal.addEventListener('abort', () => parserController.abort(), { once: true });
  }
  try {
    const response = await fetchImpl(process.env.CHAT_INTENT_URL || 'https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body), signal: parserController.signal,
    });
    if (!response.ok) throw new Error(`intent_parser_http_${response.status}`);
    const data = await response.json();
    const call = data?.choices?.[0]?.message?.tool_calls?.find((item) => item.function?.name === 'route_chat_turn');
    if (!call) throw new Error('intent_parser_missing_tool_call');
    let parsed;
    try { parsed = JSON.parse(call.function.arguments || '{}'); } catch { throw new Error('intent_parser_invalid_json'); }
    return {
      decision: normalizeIntentDecision(parsed, { message, language, allowedGroups }),
      usage: data.usage || null,
    };
  } catch (error) {
    return { decision: safeRecallDecision({ message, language, reason: error.message }), usage: null };
  } finally {
    clearTimeout(timeout);
  }
}

export function intentDecisionToPlan(decision, message) {
  const operation = decision.operation;
  return {
    intent_kind: operation === 'save' ? 'save' : operation === 'connector_write' ? 'action' : 'lookup',
    user_message: message,
    operation,
    intents: [operation],
    sub_queries: decision.queries,
    named_entities: decision.named_entities,
    recall_mode: decision.source || decision.aggregate ? 'explain' : decision.recall_mode,
    source: decision.source,
    aggregate: decision.aggregate,
    requires_complete_coverage: !!decision.aggregate,
    scope_filter: decision.scope_filter,
    tool_groups: decision.tool_groups,
    live_providers: operation === 'connector_read' && decision.connector_provider ? [decision.connector_provider] : [],
    action_intent: operation === 'connector_write' ? decision.connector_provider : null,
    save_intent: operation === 'save' ? decision.save : null,
    auto_save_intent: operation !== 'save' && decision.save?.confidence >= 0.75 ? decision.save : null,
    update_intent: operation === 'update' ? decision.update : null,
    delete_intent: operation === 'delete' ? decision.delete : null,
    recall_time: decision.time,
    continuation: decision.continuation,
    assistant_name_intent: operation === 'rename_assistant' ? decision.assistant_name : null,
    _direct_answer: operation === 'direct' ? decision.direct_response : null,
    project_prompt: decision.project_prompt,
    acknowledgement: decision.acknowledgement,
    failure_response: decision.failure_response,
    needs_traverse: false, needs_time_travel: false, time_travel: null,
    needs_web: false, ask_for_project: false, expected_evidence_types: [],
  };
}

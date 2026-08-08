/**
 * Compound multi-step orchestrator — Phase 3 of the /chat robustness plan.
 *
 * Handles requests that cannot be expressed as a single `plan.operation`:
 * e.g. "Recall Amar's project details, put them in a Doc, email it to my boss."
 * The progressive router emits a `compound_plan` tool call whose `subtasks`
 * array declares an ordered, dependency-aware plan. This module executes it.
 *
 * Design invariants (from the plan file, Phase 3):
 *  1. Reads go through `ConnectorRuntime.executeTool` (proven live in Phase 0).
 *  2. Writes do NOT go through `executeApproved` (zero callers — dead end).
 *     They are handed to the legacy `pendingWrite` draft flow via the toolkit,
 *     exactly as connector writes are approved today.
 *  3. Dependent subtasks get the PRIOR subtask's typed output fields injected
 *     into their arguments — never a JSON blob pasted into a text prompt.
 *  4. Independent subtasks (no `depends_on`) run via Promise.all.
 *  5. A `draft_created` / pending result is reported as pending, NEVER as done.
 *
 * Flag-gated by COMPOUND_ORCHESTRATOR_ENABLED (default false) in the caller.
 */

import { createHash } from 'node:crypto';
import { chatCompletionFetch } from '../llm/chat-provider.js';

// Model used for the per-subtask tool-selection step. Reuses the hardened
// synthesis path by default; env-overridable for A/B.
const SUBTASK_MODEL = process.env.COMPOUND_SUBTASK_MODEL || process.env.HIVEMIND_AGENT_MODEL || 'cerebras/gpt-oss-120b';

// Max tool-calling rounds per subtask (a subtask is a small, scoped step).
const SUBTASK_MAX_ROUNDS = 3;

// Router provider name → runtime connector id. The progressive router emits
// hyphenated provider names (google-docs, google-sheets) but the connector
// runtime registers underscore ids (google_docs, google_sheets). Mirrors the
// _RT_MAP in toolkit-factory.js.
const CONNECTOR_ID_MAP = {
  gmail: 'gmail',
  'google-docs': 'google_docs',
  'google-sheets': 'google_sheets',
  'google-gemini': 'google_gemini',
  slack: 'slack',
  notion: 'notion',
  github: 'github',
  linear: 'linear',
};

// Native HIVEMIND groups are NOT connectors — they are served by the native
// dispatchTool path (recall, save, etc.), not the connector runtime.
const NATIVE_HIVEMIND_GROUPS = new Set(['hivemind-recall', 'hivemind-memory-write', 'hivemind-projects']);

// Router provider name → Composio toolkit slug. The user's live Gmail / Docs /
// Calendar connections are Composio connections (stored in Composio's
// connected_accounts, keyed by orgId as user_id) — NOT Nango rows. So connector
// steps must dispatch through the Composio service (executeTool), not the
// legacy Nango toolkit (which only sees nangoConnection rows).
const COMPOSIO_TOOLKIT_MAP = {
  gmail: 'gmail',
  'google-drive': 'googledrive',
  'google-docs': 'googledocs',
  'google-sheets': 'googlesheets',
  'google-calendar': 'googlecalendar',
  'google-tasks': 'googletasks',
  'google-gemini': 'googlegemini',
  slack: 'slack',
  notion: 'notion',
  github: 'github',
  linear: 'linear',
};

function normalizeConnectorIds(groups) {
  return (groups || []).map((g) => CONNECTOR_ID_MAP[g] || g);
}

function composioToolkitFor(groups) {
  for (const g of groups || []) {
    const tk = COMPOSIO_TOOLKIT_MAP[g];
    if (tk) return tk;
  }
  return null;
}

export function buildCompoundSynthesisPayload({ recallResults = [], readResults = [] } = {}) {
  return {
    recall: recallResults.map((result) => ({
      memories: (result?.memories || []).slice(0, 6).map((memory, index) => ({
        id: memory?.id || null,
        title: memory?.title || null,
        content: String(memory?.content || '').slice(0, index === 0 ? 8000 : 1200),
        tags: Array.isArray(memory?.tags) ? memory.tags.slice(0, 8) : [],
      })),
      evidence: (result?.evidence || []).slice(0, 6).map((item) => ({
        document_title: item?.document_title || item?.document?.title || null,
        content: String(item?.snippet || item?.content || '').slice(0, 1200),
      })),
    })),
    connectors: readResults,
  };
}

// Provider schemas are often the largest part of a compound prompt. First
// select by compact, language-agnostic capability cards; only the one selected
// tool's schema is sent to the argument-generation turn.
export function buildToolSelectionCards(rawTools) {
  return (Array.isArray(rawTools) ? rawTools : []).map((tool) => ({
    name: String(tool?.function?.name || tool?.name || ''),
    description: String(tool?.function?.description || tool?.description || '').slice(0, 240),
  })).filter((card) => card.name);
}

const COMPOSIO_READ_ACTIONS = new Set([
  'check', 'download', 'fetch', 'find', 'get', 'inspect', 'list', 'read',
  'retrieve', 'search',
]);
const COMPOSIO_WRITE_ACTIONS = new Set([
  'add', 'append', 'archive', 'batch', 'copy', 'create', 'delete', 'disable',
  'enable', 'export', 'forward', 'import', 'insert', 'modify', 'move', 'patch',
  'post', 'remove', 'replace', 'reply', 'restore', 'send', 'stop', 'trash',
  'unmerge', 'untrash', 'update', 'watch',
]);

function composioActionTokens(tool) {
  const toolkit = String(tool?._composio?.toolkit || '').toLocaleLowerCase();
  let slug = String(tool?._composio?.slug || tool?.function?.name || tool?.name || '')
    .toLocaleLowerCase()
    .replace(/^composio[_:-]?/, '');
  if (toolkit && slug.startsWith(`${toolkit}_`)) slug = slug.slice(toolkit.length + 1);
  return slug.split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Classify provider capabilities from their controlled manifest identifier,
 * never from the user's language. Unknown actions fail closed so a read turn
 * cannot accidentally execute a side effect.
 */
export function classifyComposioToolAuthority(tool) {
  const tokens = composioActionTokens(tool);
  if (!tokens.length) return 'unknown';
  if (COMPOSIO_READ_ACTIONS.has(tokens[0])) return 'read';
  if (COMPOSIO_WRITE_ACTIONS.has(tokens[0])) return 'write';
  // Some provider manifests namespace settings before the terminal action,
  // e.g. GMAIL_SETTINGS_SEND_AS_GET. Only an explicit terminal read verb is
  // accepted here; ambiguous manifests remain unavailable rather than unsafe.
  if (COMPOSIO_READ_ACTIONS.has(tokens.at(-1))) return 'read';
  for (const token of tokens) {
    if (COMPOSIO_READ_ACTIONS.has(token)) return 'read';
    if (COMPOSIO_WRITE_ACTIONS.has(token)) return 'write';
  }
  return 'unknown';
}

function authorityForOperation(canonicalOperation = '') {
  const actions = String(canonicalOperation || '').toLocaleLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return actions.some((action) => COMPOSIO_WRITE_ACTIONS.has(action) || action === 'write') ? 'write' : 'read';
}

export function filterComposioToolsByAuthority(rawTools, canonicalOperation = '') {
  const required = authorityForOperation(canonicalOperation);
  return (Array.isArray(rawTools) ? rawTools : [])
    .filter((tool) => classifyComposioToolAuthority(tool) === required);
}

export function rankToolSelectionCards(cards, canonicalOperation = '') {
  const tokens = (value) => new Set(String(value || '').toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3));
  const intentTokens = tokens(canonicalOperation);
  if (!intentTokens.size) return [...cards];
  return cards.map((card, index) => {
    const nameTokens = tokens(card.name);
    const descriptionTokens = tokens(card.description);
    let score = 0;
    for (const token of intentTokens) {
      if (nameTokens.has(token)) score += 3;
      if (descriptionTokens.has(token)) score += 1;
    }
    return { card, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index).map(({ card }) => card);
}

function resolveMentionedTool(rawTools, text) {
  const haystack = String(text || '').toLocaleLowerCase();
  if (!haystack) return null;
  return (rawTools || []).find((tool) => {
    const name = String(tool?.function?.name || tool?.name || '').toLocaleLowerCase();
    const slug = String(tool?._composio?.slug || '').toLocaleLowerCase();
    return (name && haystack.includes(name)) || (slug && haystack.includes(slug));
  }) || null;
}

export function resolveSelectedTool(rawTools, selectedName) {
  const wanted = String(selectedName || '').trim().toLocaleLowerCase();
  if (!wanted) return null;
  const canonical = (value) => String(value || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/^composio[_:-]?/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const canonicalWanted = canonical(wanted);
  return (rawTools || []).find((tool) => {
    const name = String(tool?.function?.name || tool?.name || '').trim().toLocaleLowerCase();
    const slug = String(tool?._composio?.slug || '').trim().toLocaleLowerCase();
    return name === wanted || slug === wanted
      || canonical(name) === canonicalWanted || canonical(slug) === canonicalWanted;
  }) || null;
}

async function selectToolCard({ rawTools, message, canonicalOperation, apiKey, signal }) {
  const authorityTools = filterComposioToolsByAuthority(rawTools, canonicalOperation);
  const cards = rankToolSelectionCards(buildToolSelectionCards(authorityTools), canonicalOperation);
  const eligibleNames = new Set(cards.map((card) => card.name));
  const eligibleTools = authorityTools.filter((tool) => eligibleNames.has(String(tool?.function?.name || tool?.name || '')));
  if (!cards.length) throw new Error(`no ${authorityForOperation(canonicalOperation)} connector tool cards available`);
  const selector = {
    type: 'function',
    function: {
      name: 'select_connector_tool',
      description: 'Select exactly one connected-app capability for the user request.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { tool_name: { type: 'string', enum: cards.map((card) => card.name) } },
        required: ['tool_name'],
      },
    },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resp = await chatCompletionFetch(SUBTASK_MODEL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: SUBTASK_MODEL,
        messages: [
          { role: 'system', content: `Select the one connected-app capability that directly fulfills the requested operation in any language. The supplied capabilities have already been restricted to the planner's required read/write authority. Prefer the tool that produces the requested result over prerequisite or metadata utilities. Return exactly one tool_name from the supplied enum. Available compact capability cards: ${JSON.stringify(cards)}` },
          { role: 'user', content: message },
        ],
        tools: [selector], tool_choice: { type: 'function', function: { name: 'select_connector_tool' } },
        temperature: 0, max_tokens: 120,
      }),
      signal,
    }, { fallbackApiKey: apiKey });
    if (!resp.ok) throw new Error(`tool-card selector ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const modelMessage = data?.choices?.[0]?.message || {};
    const call = modelMessage?.tool_calls?.[0];
    let args = {};
    try { args = JSON.parse(call?.function?.arguments || '{}'); } catch {}
    const selected = resolveSelectedTool(eligibleTools, args.tool_name);
    if (selected) return selected;
    const mentioned = resolveMentionedTool(eligibleTools, modelMessage.content);
    if (mentioned) return mentioned;
  }
  // Some OpenAI-compatible providers occasionally violate an enum inside a
  // forced selector tool call. Fall back to the provider-enforced native tool
  // choice using the real manifests. This is semantic and language-neutral;
  // it is only paid on selector failure and always resolves back to a manifest
  // that actually exists, rather than turning a valid connector read into an
  // intermittent orchestration error.
  const providerTools = eligibleTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool?.function?.name,
      description: tool?.function?.description,
      parameters: tool?.function?.parameters,
    },
  }));
  const fallback = await defaultSelectTool({ tools: providerTools, message, apiKey, signal });
  const selected = resolveSelectedTool(eligibleTools, fallback?.toolName);
  if (selected) return selected;
  throw new Error('tool-card selector returned an unavailable tool after retry and governed fallback');
}

/**
 * Resolve the connector runtime singleton. The server assigns
 * globalThis.__hivemindConnectorRuntime lazily (only when a
 * /api/connectors/runtime/* or /mcp/connectors/* request arrives), so it may
 * not be present when the chat orchestrator runs. If absent, initialize it
 * here with the same pattern the server uses (getConnectorRuntime with the
 * chat ctx's prisma) — the singleton is process-lifetime, so this is cheap and
 * idempotent.
 */
async function getRuntime(ctx) {
  let rt = globalThis.__hivemindConnectorRuntime;
  if (!rt) {
    const { getConnectorRuntime } = await import('../connectors/runtime/index.js');
    rt = getConnectorRuntime({ db: ctx?.prisma, prisma: ctx?.prisma });
    try { globalThis.__hivemindConnectorRuntime = rt; } catch { /* ignore */ }
  }
  if (!rt) throw new Error('connector runtime not initialized');
  return rt;
}

/**
 * Build the execution context the runtime's validateContext requires.
 * surface must be one of SURFACES (['chat','hyperagents','tara','mcp','sync','admin','dashboard']).
 */
function buildContext(ctx, surface = 'chat') {
  return {
    requestId: ctx?._trace?.traceId || ctx?.requestId || `compound_${Date.now()}`,
    userId: ctx?.userId,
    orgId: ctx?.orgId,
    surface,
  };
}

/**
 * Extract typed output fields from a CanonicalConnectorResult so a dependent
 * subtask can reference them (e.g. {doc_id, doc_url} from a create-doc result).
 * Returns a flat object of scalar/string fields only — never a nested blob.
 */
function extractOutputFields(result) {
  const out = {};
  const meta = result?.metadata || {};
  if (meta.connector) out.connector = meta.connector;
  if (meta.tool) out.tool = meta.tool;
  // Content blocks: prefer json data, then text.
  const blocks = Array.isArray(result?.content) ? result.content : [];
  for (const b of blocks) {
    if (b?.type === 'json' && b.data && typeof b.data === 'object') {
      for (const [k, v] of Object.entries(b.data)) {
        if (v == null) continue;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          out[k] = v;
        }
      }
    } else if (b?.type === 'text' && typeof b.text === 'string') {
      // Only surface short text as a field (avoid dumping huge bodies).
      if (b.text.length <= 400 && !out._text) out._text = b.text;
    }
  }
  return out;
}

/**
 * Inject prior subtask output fields into a dependent subtask's arguments.
 * Only fields the subtask's own tool schema declares are injected — never a
 * free-form blob. `toolSchema` is the JSON schema of the target tool.
 */
function injectDependencies(args, priorOutputs, toolSchema) {
  if (!priorOutputs || Object.keys(priorOutputs).length === 0) return args;
  const props = toolSchema?.properties || {};
  const next = { ...(args || {}) };
  for (const [k, v] of Object.entries(priorOutputs)) {
    // Only inject into declared properties, and never overwrite an explicit arg.
    if (props[k] && next[k] == null) {
      next[k] = v;
    }
  }
  return next;
}

function missingRequiredArgs(schema, args) {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  return required.filter((name) => {
    const value = args?.[name];
    return value == null || (typeof value === 'string' && value.trim() === '');
  });
}

/**
 * Default tool-selection step: scope the model's tool choices to the subtask's
 * connector group and let it pick ONE tool + args. Injectable for tests.
 * Returns { toolName, args, schema } or null on failure.
 */
async function defaultSelectTool({ tools, message, apiKey, signal }) {
  const sys = `You are executing ONE step of a multi-step task. Use ONLY the supplied tools. Choose the single tool that best accomplishes this step and provide its arguments. If a prior step produced fields (doc_id, doc_url, etc.), reuse them verbatim. Do not invent tool names.`;
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: message },
  ];
  for (let round = 0; round < SUBTASK_MAX_ROUNDS; round++) {
    const resp = await chatCompletionFetch(SUBTASK_MODEL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: SUBTASK_MODEL, messages, tools, tool_choice: 'auto', temperature: 0, max_tokens: 700 }),
      signal,
    }, { fallbackApiKey: apiKey });
    if (!resp.ok) {
      throw new Error(`subtask model ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const data = await resp.json();
    const msg = data?.choices?.[0]?.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length === 0) {
      throw new Error(String(msg.content || 'no tool selected').slice(0, 300));
    }
    const call = calls[0];
    const toolName = call.function?.name;
    let args = {};
    try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
    const manifest = tools.find((t) => t.function.name === toolName);
    const schema = manifest?.function?.parameters || { properties: {} };
    return { toolName, args, schema };
  }
  throw new Error('subtask exceeded tool-selection rounds');
}

async function rewriteCompoundRecallQuery({ message, canonicalOperation, originalRequest, apiKey, signal }) {
  const structuralFallback = String(canonicalOperation || '')
    .split(/[_\s]+/)
    .slice(1)
    .join(' ')
    .trim() || message;
  try {
    const resp = await chatCompletionFetch(SUBTASK_MODEL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: SUBTASK_MODEL,
        messages: [
          { role: 'system', content: 'Rewrite one zero-coverage memory-recall subtask into one compact, language-independent semantic retrieval query. Preserve entities and requested attributes; remove orchestration verbs and connector-only context. Return strict JSON {"query":string}.' },
          { role: 'user', content: JSON.stringify({ subtask: message, canonical_operation: canonicalOperation, overall_request: originalRequest }).slice(0, 1600) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 100,
      }),
      signal,
    }, { fallbackApiKey: apiKey });
    if (!resp.ok) return structuralFallback;
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(content);
    return typeof parsed?.query === 'string' && parsed.query.trim()
      ? parsed.query.trim().slice(0, 160)
      : structuralFallback;
  } catch {
    return structuralFallback;
  }
}

/**
 * Run a native HIVEMIND step (recall / save / projects) via the native
 * dispatchTool path — the same path the rest of /api/chat uses. The connector
 * runtime has no hivemind-* connectors, so these must NOT go through
 * runtime.listTools/executeTool. Returns the same shape as runSubtask.
 */
async function runNativeHivemindStep({ subtask, ctx, priorOutputs, onEvent }) {
  const message = subtask.message || '';
  const toolName = 'hivemind_recall';
  const args = {
    query: message,
    query_original: message,
    query_canonical_en: message,
    // Compound recall must preserve the same retrieval/delivery contract as
    // the native progressive chat lane. These are trusted server controls:
    // they do not change hybrid ranking, but prevent the public 400-character
    // preview from becoming the evidence available to final synthesis.
    _structured_intent: true,
    semantic_recovery: true,
    _include_full_memory_content: true,
    ...(priorOutputs && Object.keys(priorOutputs).length ? { context: priorOutputs } : {}),
  };
  const emit = onEvent || (() => {});
  emit({ type: 'tool_call', name: toolName, arguments: JSON.stringify(args) });
  try {
    // dispatchTool is the canonical native tool dispatcher (same as chat's
    // recall path). Fall back to ctx._tracedDispatch if present.
    const dispatch = ctx?._tracedDispatch || ctx?._dispatchTool;
    if (!dispatch) {
      emit({ type: 'tool_result', name: toolName, status: 'error', summary: 'native dispatch unavailable' });
      return { status: 'error', error: 'native hivemind dispatch unavailable', toolName, args, result: null, draftId: null, outputFields: {} };
    }
    let result = await dispatch('hivemind_recall', args, ctx);
    if (!result?.error && (result?.memories?.length || 0) === 0 && (result?.evidence?.length || 0) === 0) {
      const rewriteRecall = ctx?._rewriteCompoundRecallQuery || rewriteCompoundRecallQuery;
      const retryQuery = await rewriteRecall({
        message,
        canonicalOperation: subtask.operation,
        originalRequest: ctx?._originalUserMessage || message,
        apiKey: ctx?._apiKey,
        signal: ctx?._signal,
      });
      if (retryQuery && retryQuery !== message) {
        emit({ type: 'query_optimized', queries: [retryQuery], reason: 'compound_zero_coverage_retry' });
        result = await dispatch('hivemind_recall', {
          ...args,
          query: retryQuery,
          query_canonical_en: retryQuery,
        }, ctx);
      }
    }
    if (result?.error) {
      emit({ type: 'tool_result', name: toolName, status: 'error', summary: result.error });
      return { status: 'error', error: result.error, toolName, args, result, draftId: null, outputFields: {} };
    }
    // Extract a compact text summary + any scalar output fields for downstream
    // steps (e.g. the doc-creation step can reference recalled facts).
    const text = result?.content || result?.response || result?.summary || JSON.stringify(result).slice(0, 2000);
    const outputFields = { recall: String(text).slice(0, 2000) };
    emit({ type: 'tool_result', name: toolName, status: 'completed', summary: String(text).slice(0, 240) });
    return { status: 'completed', result, toolName, args, draftId: null, outputFields, error: null };
  } catch (err) {
    emit({ type: 'tool_result', name: toolName, status: 'error', summary: err.message });
    return { status: 'error', error: err.message, toolName, args, result: null, draftId: null, outputFields: {} };
  }
}

/**
 * Run one subtask: scope the model's tool choices to the subtask's connector
 * group, let it pick a tool + args, then dispatch by the tool's manifest.
 *
 * Returns { status, result, toolName, args, draftId, outputFields }.
 * status ∈ 'completed' | 'draft_created' | 'error' | 'not_connected' | ...
 */
async function runSubtask({ subtask, context, ctx, apiKey, signal, priorOutputs, selectTool = defaultSelectTool, onEvent, composio }) {
  const toolGroups = Array.isArray(subtask.tool_groups) ? subtask.tool_groups : [];
  const message = subtask.message || '';
  const emit = onEvent || (() => {});
  // Composio service functions — injectable for tests; defaults to the real
  // service (lazy import so tests can pass a stub without hitting the API).
  const composioSvc = composio || await (async () => {
    const m = await import('../connectors/composio/composio-service.js');
    return { getToolkitTools: m.getToolkitTools, executeTool: m.executeTool };
  })();

  // Native HIVEMIND step (recall / save / projects) — NOT a connector. Run it
  // through the native dispatchTool path so recall actually reaches the memory
  // engine. The connector runtime has no hivemind-* connectors. Checked BEFORE
  // getRuntime so a native step never touches (or lazily initializes) the
  // connector runtime.
  if (toolGroups.some((g) => NATIVE_HIVEMIND_GROUPS.has(g))) {
    return runNativeHivemindStep({ subtask, ctx, priorOutputs, onEvent });
  }

  // 1. Scope the model's tool choices to this subtask's connector group.
  //    The user's live connections are COMPOSIO connections, so load the tool
  //    schemas from the Composio service (getToolkitTools) — NOT the legacy
  //    Nango toolkit or the connector runtime (both key off nangoConnection,
  //    which is empty for Composio-connected orgs).
  const composioToolkit = composioToolkitFor(toolGroups);
  let tools = [];
  let composioSlugByTool = new Map();
  let composioManifestByTool = new Map();
  if (composioToolkit) {
    try {
      const raw = await composioSvc.getToolkitTools(composioToolkit);
      // PROGRESSIVE LOADING: narrow the toolkit's full tool list to only the
      // tools relevant to THIS subtask's operation + message. Composio has no
      // semantic /tools/search on this deployment (probed → 404), so we do a
      // lightweight local relevance filter on the tool name + description.
      // This keeps each subtask's prompt small (a handful of tools, not the
      // whole toolkit) — the exact "don't bloat the prompt" goal, achieved
      // with what actually exists.
      // The production path selects semantically from compact cards, then
      // supplies exactly one full schema to argument generation. Test
      // selectors retain the complete local list for deterministic fixtures.
      const relevant = selectTool === defaultSelectTool
        ? [await selectToolCard({ rawTools: raw, message, canonicalOperation: subtask.operation, apiKey, signal })]
        : raw;
      tools = relevant.map((t) => ({
        type: 'function',
        function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters },
      }));
      for (const t of relevant) {
        composioSlugByTool.set(t.function.name, t._composio?.slug);
        composioManifestByTool.set(t.function.name, t);
      }
    } catch (err) {
      return { status: 'error', error: `composio tools failed: ${err.message}`, toolName: null, args: null, result: null, draftId: null, outputFields: {} };
    }
  }
  if (tools.length === 0) {
    return { status: 'error', error: `no composio tools available for connector group(s): ${toolGroups.join(',') || '(none)'}`, toolName: null, args: null, result: null, draftId: null, outputFields: {} };
  }

  // 2. Small tool-calling step: pick ONE tool + args for this subtask.
  let chosen = null;
  try {
    chosen = await selectTool({ tools, message, apiKey, signal });
  } catch (err) {
    return { status: 'error', error: err.message, toolName: null, args: null, result: null, draftId: null, outputFields: {} };
  }
  if (!chosen) {
    return { status: 'error', error: 'no tool selected', toolName: null, args: null, result: null, draftId: null, outputFields: {} };
  }
  const { toolName, args: rawArgs } = chosen;
  const composioSlug = composioSlugByTool.get(toolName) || null;

  // 3. Dependency injection uses the chosen tool's schema (authoritative for
  //    which fields the tool accepts).
  const manifestSchema = chosen.schema || { properties: {} };
  const args = injectDependencies(rawArgs, priorOutputs, manifestSchema);

  // Emit the tool_call event so the FE shows live activity for this step.
  emit({ type: 'tool_call', name: toolName, arguments: JSON.stringify(args) });

  // 4. Dispatch through Composio. Reads execute immediately; writes go through
  //    the pendingWrite draft-approval flow (never reported as done until the
  //    user approves and the write actually executes).
  const composioExecute = composioSvc.executeTool;
  const orgId = ctx?.orgId;
  if (!orgId || !composioSlug) {
    emit({ type: 'tool_result', name: toolName, status: 'error', summary: 'no composio connection' });
    return { status: 'error', error: 'no composio connection for this step', toolName, args, result: null, draftId: null, outputFields: {} };
  }

  // Reuse the same controlled-manifest authority decision used before model
  // selection. This prevents read tools such as GET_LABEL from being mistaken
  // for writes merely because their resource name contains "label".
  const selectedManifest = composioManifestByTool.get(toolName);
  const selectedAuthority = classifyComposioToolAuthority(selectedManifest);
  if (selectedAuthority === 'unknown') {
    emit({ type: 'tool_result', name: toolName, status: 'error', summary: 'unknown connector tool authority' });
    return { status: 'error', error: 'unknown connector tool authority', toolName, args, result: null, draftId: null, outputFields: {} };
  }
  const isWrite = selectedAuthority === 'write';

  if (!isWrite) {
    // Read — execute immediately via Composio.
    const result = await composioExecute(orgId, composioSlug, args);
    const status = result?.successful ? 'completed' : 'failed';
    const outputFields = result?.data && typeof result.data === 'object' ? result.data : {};
    emit({ type: 'tool_result', name: toolName, status, summary: (result?.error || (result?.successful ? 'completed' : 'failed')).slice(0, 240) });
    return {
      status,
      result,
      toolName,
      args,
      draftId: null,
      outputFields,
      error: status === 'completed' ? null : (result?.error || status),
    };
  }

  // A draft is an approval artifact, not a deferred schema validator. Ask for
  // provider-required information before persisting one, so approval cannot
  // fail merely because the planner omitted a required field.
  const missing = missingRequiredArgs(manifestSchema, args);
  if (missing.length) {
    const error = `Missing required fields: ${missing.join(', ')}`;
    emit({ type: 'tool_result', name: toolName, status: 'needs_input', summary: error });
    return { status: 'needs_input', error, toolName, args, result: null, draftId: null, outputFields: {} };
  }

  // Write — create a pendingWrite draft for approval. The draft stores the
  // Composio slug + args; on approval the write executes via Composio.
  const draftId = await createComposioDraft(ctx, composioSlug, args, toolName);
  if (!draftId) {
    emit({ type: 'tool_result', name: toolName, status: 'error', summary: 'draft creation failed' });
    return { status: 'error', error: 'write draft creation failed', toolName, args, result: null, draftId: null, outputFields: {} };
  }
  emit({ type: 'tool_result', name: toolName, status: 'draft_created', summary: 'draft created — awaiting approval' });
  return {
    status: 'draft_created',
    result: { status: 'draft_created', draft_id: draftId },
    toolName,
    args,
    draftId,
    outputFields: {},
    error: null,
  };
}

/**
 * Create a pendingWrite draft row for a Composio write. On approval, the
 * approval handler re-dispatches and executes the Composio tool. Returns the
 * draft id, or null on failure.
 */
async function createComposioDraft(ctx, composioSlug, args, toolName) {
  if (!ctx?.prisma) return null;
  try {
    const preview = `${toolName}(${JSON.stringify(args).slice(0, 200)})`;
    const row = await ctx.prisma.pendingWrite.create({
      data: {
        userId: ctx.userId,
        orgId: ctx.orgId || null,
        provider: 'composio',
        toolGroup: 'composio',
        toolName: composioSlug,
        toolArgs: { ...(args || {}), _composio_slug: composioSlug },
        argsHash: JSON.stringify(args || {}),
        projectId: ctx.projectId || null,
        connectionId: null,
        traceId: ctx._trace?.traceId || null,
        // Include the traceId so each turn creates a distinct draft (the
        // idempotency_key column is UNIQUE — a deterministic key collides on a
        // second identical request). The traceId scopes retries within one turn.
        // Hashed to a fixed 64-char hex so it never exceeds the VarChar(160)
        // column limit (the raw concatenation with full args was too long).
        idempotencyKey: createHash('sha256')
          .update(`composio:${ctx.orgId}:${ctx.userId}:${composioSlug}:${ctx._trace?.traceId || Date.now()}:${JSON.stringify(args || {})}`)
          .digest('hex'),
        expiresAt: new Date(Date.now() + Number(process.env.CHAT_DRAFT_TTL_MS || 15 * 60_000)),
        preview,
        status: 'draft',
      },
    });
    return row?.id || null;
  } catch (err) {
    console.warn(`[compound] composio draft create failed: ${err.message}`);
    return null;
  }
}

/**
 * Execute a compound plan.
 *
 * @param {object} opts
 * @param {Array}  opts.subtasks  [{ operation, tool_groups, depends_on, message }]
 * @param {object} opts.ctx       the chat ctx (userId, orgId, _toolkit, _trace)
 * @param {string} opts.apiKey
 * @param {AbortSignal} opts.signal
 * @param {Function} [opts.selectTool]  override for the per-subtask tool-selection
 *   step (tests inject a deterministic selector; production uses the model).
 * @param {Function} [opts.onEvent]  SSE emitter — receives tool_call/tool_result
 *   events per subtask so the FE can stream live activity (matches the desktop
 *   / mobile chat Thinking animation contract).
 * @param {object} [opts.composio]  override for the Composio service functions
 *   ({ getToolkitTools, executeTool }) — tests inject a stub; production uses
 *   the real service.
 * @returns {Promise<{ steps: Array, draftIds: Array, summary: string, status: string }>}
 */
export async function runCompoundOrchestrator({ subtasks, ctx, apiKey, signal, selectTool, onEvent, composio }) {
  const context = buildContext(ctx, 'chat');
  const steps = [];
  const draftIds = [];
  const results = new Array(subtasks.length);
  const outputs = new Array(subtasks.length); // typed output fields per subtask

  // Topological execution with fan-out: each pass collects every subtask whose
  // depends_on are all done and runs them TOGETHER via Promise.all. Independent
  // subtasks (no depends_on on each other — e.g. "check GitHub AND Linear")
  // therefore run in parallel, cutting wall-clock latency to ~max(t1,t2) rather
  // than t1+t2. A subtask that depends on a prior result still waits for that
  // result to resolve before it is collected in a later pass. Results are
  // written back by index, so ordering and the draft_created/pending invariant
  // are preserved regardless of completion timing.
  const done = new Array(subtasks.length).fill(false);
  let guard = 0;
  while (done.some((d) => !d) && guard < subtasks.length * 2 + 1) {
    guard += 1;
    // Collect the ready batch (all deps done, not yet run).
    const ready = [];
    for (let i = 0; i < subtasks.length; i++) {
      if (done[i]) continue;
      const st = subtasks[i];
      const deps = Array.isArray(st.depends_on) ? st.depends_on : [];
      if (deps.every((d) => done[d])) ready.push(i);
    }
    if (ready.length === 0) break; // deadlock or unsatisfiable dependency
    // Run the whole ready batch in parallel.
    const batchResults = await Promise.all(ready.map((i) => {
      const st = subtasks[i];
      const deps = Array.isArray(st.depends_on) ? st.depends_on : [];
      const priorOutputs = {};
      for (const d of deps) Object.assign(priorOutputs, outputs[d] || {});
      return runSubtask({ subtask: st, context, ctx, apiKey, signal, priorOutputs, selectTool, onEvent, composio });
    }));
    // Write results back by index (order preserved).
    for (let k = 0; k < ready.length; k++) {
      const i = ready[k];
      const r = batchResults[k];
      results[i] = r;
      outputs[i] = r.outputFields || {};
      done[i] = true;
      steps.push({
        index: i,
        operation: subtasks[i].operation || 'tool',
        tool: r.toolName,
        status: r.status,
        summary: r.error || (r.status === 'completed' ? 'completed' : r.status),
        draft_id: r.draftId || null,
      });
      if (r.draftId) draftIds.push(r.draftId);
    }
  }

  // Build the user-facing summary. CRITICAL: a draft_created / pending result
  // is reported as pending, never as done.
  const lines = [];
  let anyPending = false;
  let anyNeedsInput = false;
  let anyError = false;
  for (let i = 0; i < subtasks.length; i++) {
    const st = subtasks[i];
    const r = results[i];
    if (!r) { lines.push(`Step ${i + 1} (${st.operation || 'tool'}): not executed`); anyError = true; continue; }
    if (r.status === 'completed') {
      lines.push(`Step ${i + 1} (${st.operation || 'tool'}): done`);
    } else if (r.status === 'draft_created') {
      lines.push(`Step ${i + 1} (${st.operation || 'tool'}): draft created — awaiting your approval`);
      anyPending = true;
    } else if (r.status === 'needs_input') {
      lines.push(`Step ${i + 1} (${st.operation || 'tool'}): needs information — ${r.error || 'missing required fields'}`);
      anyNeedsInput = true;
    } else {
      lines.push(`Step ${i + 1} (${st.operation || 'tool'}): ${r.error || r.status}`);
      anyError = true;
    }
  }
  const status = anyError ? 'error' : (anyPending ? 'pending' : (anyNeedsInput ? 'needs_input' : 'completed'));
  // Preserve canonical recall results verbatim. The short `outputFields.recall`
  // value is only for dependency injection; it is never the evidence payload
  // that a final synthesis or client may rely on.
  const recallResults = results
    .filter((result, index) => Array.isArray(subtasks[index]?.tool_groups)
      && subtasks[index].tool_groups.some((group) => NATIVE_HIVEMIND_GROUPS.has(group))
      && result?.result)
    .map((result) => result.result);
  const readResults = results.flatMap((result, index) => {
    if (result?.status !== 'completed' || !result?.result) return [];
    const groups = Array.isArray(subtasks[index]?.tool_groups) ? subtasks[index].tool_groups : [];
    if (groups.some((group) => NATIVE_HIVEMIND_GROUPS.has(group))) return [];
    return [{
      index,
      operation: subtasks[index]?.operation || 'read',
      tool: result.toolName || null,
      data: result.result?.data ?? result.outputFields ?? null,
    }];
  });
  return {
    steps,
    draftIds,
    summary: lines.join('\n'),
    status,
    recallResults,
    readResults,
    synthesisPayload: buildCompoundSynthesisPayload({ recallResults, readResults }),
  };
}

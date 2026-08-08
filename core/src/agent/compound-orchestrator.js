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

import { chatCompletionFetch } from '../llm/chat-provider.js';

// Model used for the per-subtask tool-selection step. Reuses the hardened
// synthesis path by default; env-overridable for A/B.
const SUBTASK_MODEL = process.env.COMPOUND_SUBTASK_MODEL || process.env.HIVEMIND_AGENT_MODEL || 'cerebras/gpt-oss-120b';

// Max tool-calling rounds per subtask (a subtask is a small, scoped step).
const SUBTASK_MAX_ROUNDS = 3;

/**
 * Resolve the connector runtime singleton. The server assigns
 * globalThis.__hivemindConnectorRuntime at boot (see connectors/runtime/index.js).
 */
function getRuntime() {
  const rt = globalThis.__hivemindConnectorRuntime;
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

/**
 * Run one subtask: scope the model's tool choices to the subtask's connector
 * group, let it pick a tool + args, then dispatch by the tool's manifest.
 *
 * Returns { status, result, toolName, args, draftId, outputFields }.
 * status ∈ 'completed' | 'draft_created' | 'error' | 'not_connected' | ...
 */
async function runSubtask({ subtask, context, ctx, apiKey, signal, priorOutputs, selectTool = defaultSelectTool }) {
  const runtime = getRuntime();
  const toolGroups = Array.isArray(subtask.tool_groups) ? subtask.tool_groups : [];
  const message = subtask.message || '';

  // 1. Scope the model's tool choices to this subtask's connector group.
  let catalog;
  try {
    catalog = await runtime.listTools(context, { connectors: toolGroups });
  } catch (err) {
    return { status: 'error', error: `listTools failed: ${err.message}`, toolName: null, args: null, result: null, draftId: null, outputFields: {} };
  }
  const tools = [];
  for (const group of catalog) {
    for (const t of group.tools || []) {
      // Only tools allowed on the chat surface.
      if (Array.isArray(t.allowedSurfaces) && !t.allowedSurfaces.includes('chat')) continue;
      tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      });
    }
  }
  if (tools.length === 0) {
    return { status: 'error', error: `no tools available for connector group(s): ${toolGroups.join(',') || '(none)'}`, toolName: null, args: null, result: null, draftId: null, outputFields: {} };
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

  // 3. Resolve the canonical tool manifest from the runtime registry. Its
  // inputSchema is the AUTHORITATIVE declaration of which fields the tool
  // accepts — dependency injection must use it (never the selector's schema,
  // which may be a loose projection).
  let manifest = null;
  try {
    const resolved = runtime.registry?.resolveTool?.(toolName);
    manifest = resolved?.tool || null;
  } catch { /* fall through */ }
  const manifestSchema = manifest?.inputSchema || chosen.schema || { properties: {} };
  const args = injectDependencies(rawArgs, priorOutputs, manifestSchema);
  const access = manifest?.access || 'read';
  const approval = manifest?.approval || 'never';

  if (access === 'read' || approval === 'never') {
    // Read (or non-approval write) — execute directly via the runtime.
    const result = await runtime.executeTool(toolName, args, context);
    const status = result?.status || 'failed';
    const outputFields = extractOutputFields(result);
    return {
      status,
      result,
      toolName,
      args,
      draftId: null,
      outputFields,
      error: status === 'completed' ? null : (result?.content?.[0]?.text || status),
    };
  }

  // Write requiring approval — hand to the legacy pendingWrite draft flow via
  // the toolkit (which carries the draft-approval middleware). This produces a
  // draft_created result the user must approve; it is NEVER reported as done.
  const toolkit = ctx?._toolkit;
  if (!toolkit) {
    return { status: 'error', error: 'write requires approval but no toolkit available', toolName, args, result: null, draftId: null, outputFields: {} };
  }
  try {
    const toolResp = await toolkit.execute(toolName, args, ctx);
    const text = toolResp?.content?.[0]?.text || '';
    const status = toolResp?.status || 'failed';
    const draftId = toolResp?.meta?.draft_id || null;
    return {
      status,
      result: toolResp,
      toolName,
      args,
      draftId,
      outputFields: {},
      error: status === 'draft_created' ? null : (text || status),
    };
  } catch (err) {
    return { status: 'error', error: err.message, toolName, args, result: null, draftId: null, outputFields: {} };
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
 * @returns {Promise<{ steps: Array, draftIds: Array, summary: string, status: string }>}
 */
export async function runCompoundOrchestrator({ subtasks, ctx, apiKey, signal, selectTool }) {
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
      return runSubtask({ subtask: st, context, ctx, apiKey, signal, priorOutputs, selectTool });
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
    } else {
      lines.push(`Step ${i + 1} (${st.operation || 'tool'}): ${r.error || r.status}`);
      anyError = true;
    }
  }
  const status = anyError ? 'error' : (anyPending ? 'pending' : 'completed');
  return {
    steps,
    draftIds,
    summary: lines.join('\n'),
    status,
  };
}

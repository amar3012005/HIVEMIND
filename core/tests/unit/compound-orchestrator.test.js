import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCompoundOrchestrator } from '../../src/agent/compound-orchestrator.js';

// ── Test harness ─────────────────────────────────────────────────────────────
// A deterministic tool-selector replaces the model call so the orchestration
// logic (dependency ordering, output-field injection, status reporting) is
// tested in isolation. `pick` maps subtask message → { toolName, args }.

function makeRuntime({ tools, executeImpl }) {
  const registry = {
    resolveTool(name) {
      const t = tools.find((x) => x.name === name);
      return t ? { tool: t, connectorId: name.split('__')[0], canonicalName: name } : null;
    },
  };
  return {
    registry,
    async listTools() {
      return [{ connector: 'mock', tools }];
    },
    async executeTool(name, input) {
      return executeImpl(name, input);
    },
  };
}

function makeSelector(pick) {
  return async ({ message }) => {
    const p = pick(message);
    if (!p) throw new Error('no tool selected');
    return { toolName: p.toolName, args: p.args || {}, schema: { type: 'object', properties: {} } };
  };
}

test('compound orchestrator: independent subtasks run and report completed', async () => {
  const calls = [];
  const runtime = makeRuntime({
    tools: [
      { name: 'hivemind__recall', access: 'read', approval: 'never', allowedSurfaces: ['chat'], inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'gmail__search', access: 'read', approval: 'never', allowedSurfaces: ['chat'], inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    ],
    executeImpl: async (name, input) => {
      calls.push({ name, input });
      return { status: 'completed', content: [{ type: 'text', text: 'ok' }], metadata: { connector: name.split('__')[0], tool: name } };
    },
  });
  globalThis.__hivemindConnectorRuntime = runtime;
  const ctx = { userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' }, _toolkit: null };

  const res = await runCompoundOrchestrator({
    subtasks: [
      { operation: 'recall', tool_groups: ['hivemind'], depends_on: null, message: 'recall X' },
      { operation: 'search', tool_groups: ['gmail'], depends_on: null, message: 'search Y' },
    ],
    ctx,
    apiKey: 'k',
    signal: null,
    selectTool: makeSelector((m) => m.startsWith('recall') ? { toolName: 'hivemind__recall', args: { q: m } } : { toolName: 'gmail__search', args: { query: m } }),
  });

  assert.equal(res.status, 'completed');
  assert.equal(calls.length, 2);
  assert.equal(res.steps.length, 2);
  assert.ok(res.steps.every((s) => s.status === 'completed'));
  assert.equal(res.draftIds.length, 0);
});

test('compound orchestrator: dependent subtask receives prior typed output fields', async () => {
  const calls = [];
  const runtime = makeRuntime({
    tools: [
      { name: 'docs__create', access: 'write', approval: 'never', allowedSurfaces: ['chat'], inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
      { name: 'gmail__send', access: 'write', approval: 'required', allowedSurfaces: ['chat'], inputSchema: { type: 'object', properties: { doc_id: { type: 'string' }, doc_url: { type: 'string' }, to: { type: 'string' } } } },
    ],
    executeImpl: async (name, input) => {
      calls.push({ name, input });
      if (name === 'docs__create') {
        return { status: 'completed', content: [{ type: 'json', data: { doc_id: 'DOC123', doc_url: 'https://docs/x' } }], metadata: { connector: 'docs', tool: name } };
      }
      return { status: 'completed', content: [{ type: 'text', text: 'sent' }], metadata: { connector: 'gmail', tool: name } };
    },
  });
  globalThis.__hivemindConnectorRuntime = runtime;
  // gmail__send is a write requiring approval → goes through the toolkit's
  // pendingWrite flow. Provide a toolkit that records the args it receives so
  // we can assert the doc_id/doc_url were injected from the prior step.
  const toolkitCalls = [];
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' },
    _toolkit: {
      async execute(name, args) {
        toolkitCalls.push({ name, args });
        return { status: 'draft_created', content: [{ type: 'text', text: 'Draft created' }], meta: { draft_id: 'DRAFT1' } };
      },
    },
  };

  const res = await runCompoundOrchestrator({
    subtasks: [
      { operation: 'create_doc', tool_groups: ['docs'], depends_on: null, message: 'create doc' },
      { operation: 'send_email', tool_groups: ['gmail'], depends_on: [0], message: 'email it' },
    ],
    ctx,
    apiKey: 'k',
    signal: null,
    selectTool: makeSelector((m) => m.startsWith('create') ? { toolName: 'docs__create', args: { title: 'Amar project' } } : { toolName: 'gmail__send', args: { to: 'boss@x.com' } }),
  });

  // The overall status is 'pending' (the email is a draft awaiting approval),
  // but the dependency injection must still have happened.
  assert.equal(res.status, 'pending');
  // The dependent gmail send call must have received doc_id injected from the
  // prior docs__create result — NOT re-typed by the model. The write goes
  // through the toolkit, which uses the mapped toolkit name (gmail_send_email).
  const sendCall = toolkitCalls.find((c) => c.name === 'gmail_send_email');
  assert.ok(sendCall, 'gmail_send_email should have been called (mapped from gmail__send)');
  assert.equal(sendCall.args.doc_id, 'DOC123', 'doc_id must be injected from prior result');
  assert.equal(sendCall.args.doc_url, 'https://docs/x', 'doc_url must be injected from prior result');
  assert.equal(sendCall.args.to, 'boss@x.com', 'explicit args preserved');
});

test('compound orchestrator: draft_created is reported as pending, never done', async () => {
  const runtime = makeRuntime({
    tools: [
      { name: 'gmail__send', access: 'write', approval: 'required', allowedSurfaces: ['chat'], inputSchema: { type: 'object', properties: { to: { type: 'string' } } } },
    ],
    executeImpl: async () => ({ status: 'completed', content: [{ type: 'text', text: 'x' }] }),
  });
  globalThis.__hivemindConnectorRuntime = runtime;
  // Simulate the legacy pendingWrite flow: toolkit.execute returns draft_created.
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' },
    _toolkit: {
      async execute(name, args) {
        return { status: 'draft_created', content: [{ type: 'text', text: 'Draft created' }], meta: { draft_id: 'DRAFT1' } };
      },
    },
  };

  const res = await runCompoundOrchestrator({
    subtasks: [
      { operation: 'send_email', tool_groups: ['gmail'], depends_on: null, message: 'email boss' },
    ],
    ctx,
    apiKey: 'k',
    signal: null,
    selectTool: makeSelector(() => ({ toolName: 'gmail__send', args: { to: 'boss@x.com' } })),
  });

  // CRITICAL: a draft_created result must be reported as pending, never as done.
  assert.equal(res.status, 'pending');
  assert.equal(res.draftIds.length, 1);
  assert.equal(res.draftIds[0], 'DRAFT1');
  assert.ok(res.summary.includes('awaiting your approval'), 'summary must say awaiting approval');
  assert.ok(!res.summary.includes('done'), 'summary must NOT claim the write is done');
});

test('compound orchestrator: write with no toolkit reports error, not done', async () => {
  const runtime = makeRuntime({
    tools: [
      { name: 'gmail__send', access: 'write', approval: 'required', allowedSurfaces: ['chat'], inputSchema: { type: 'object', properties: { to: { type: 'string' } } } },
    ],
    executeImpl: async () => ({ status: 'completed', content: [{ type: 'text', text: 'x' }] }),
  });
  globalThis.__hivemindConnectorRuntime = runtime;
  const ctx = { userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' }, _toolkit: null };

  const res = await runCompoundOrchestrator({
    subtasks: [
      { operation: 'send_email', tool_groups: ['gmail'], depends_on: null, message: 'email boss' },
    ],
    ctx,
    apiKey: 'k',
    signal: null,
    selectTool: makeSelector(() => ({ toolName: 'gmail__send', args: { to: 'boss@x.com' } })),
  });

  assert.equal(res.status, 'error');
  assert.ok(res.summary.includes('no toolkit'), 'must report the missing-toolkit error');
});

test('compound orchestrator: independent subtasks run in parallel (fan-out/merge)', async () => {
  const calls = [];
  const runtime = makeRuntime({
    tools: [
      { name: 'github__list', access: 'read', approval: 'never', allowedSurfaces: ['chat'], inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'linear__list', access: 'read', approval: 'never', allowedSurfaces: ['chat'], inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'slack__post', access: 'write', approval: 'required', allowedSurfaces: ['chat'], inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ],
    executeImpl: async (name, input) => {
      calls.push({ name, input, t: Date.now() });
      // Simulate a 300ms call so we can measure parallelism.
      await new Promise((r) => setTimeout(r, 300));
      return { status: 'completed', content: [{ type: 'json', data: { count: 1 } }], metadata: { connector: name.split('__')[0], tool: name } };
    },
  });
  globalThis.__hivemindConnectorRuntime = runtime;
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' },
    _toolkit: { async execute(name, args) { return { status: 'draft_created', content: [{ type: 'text', text: 'draft' }], meta: { draft_id: 'D' } }; } },
  };

  const t0 = Date.now();
  const res = await runCompoundOrchestrator({
    subtasks: [
      { operation: 'github', tool_groups: ['github'], depends_on: null, message: 'check github' },
      { operation: 'linear', tool_groups: ['linear'], depends_on: null, message: 'check linear' },
      { operation: 'merge', tool_groups: ['github'], depends_on: [0, 1], message: 'merge' },
      { operation: 'slack', tool_groups: ['slack'], depends_on: [2], message: 'post to slack' },
    ],
    ctx,
    apiKey: 'k',
    signal: null,
    selectTool: makeSelector((m) => {
      if (m.startsWith('check github')) return { toolName: 'github__list', args: { q: m } };
      if (m.startsWith('check linear')) return { toolName: 'linear__list', args: { q: m } };
      if (m.startsWith('merge')) return { toolName: 'github__list', args: { q: m } };
      return { toolName: 'slack__post', args: { text: m } };
    }),
  });
  const elapsed = Date.now() - t0;

  // github + linear are independent → run in parallel (~300ms), NOT sequential (~600ms).
  // merge waits on both, slack waits on merge.
  console.log(`  fan-out elapsed: ${elapsed}ms (4 steps, 2 parallel + 2 sequential)`);
  assert.equal(res.status, 'pending'); // slack is a draft → pending
  assert.equal(calls.length, 3); // github, linear, merge (slack goes to toolkit)
  // github and linear must have STARTED within a small window of each other.
  const gh = calls.find((c) => c.name === 'github__list');
  const ln = calls.find((c) => c.name === 'linear__list');
  assert.ok(gh && ln, 'github and linear both called');
  const startDelta = Math.abs(gh.t - ln.t);
  assert.ok(startDelta < 100, `github+linear should start together (delta ${startDelta}ms)`);
  // Total should be ~2 sequential hops (parallel pair + merge), not 4.
  assert.ok(elapsed < 900, `fan-out should be ~600ms not ~1200ms (got ${elapsed}ms)`);
});

test('compound orchestrator: native hivemind-recall step runs via dispatchTool, not connector runtime', async () => {
  // No connector runtime set — the native path must not touch it.
  delete globalThis.__hivemindConnectorRuntime;
  const dispatched = [];
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' }, _toolkit: null,
    _tracedDispatch: async (name, args) => {
      dispatched.push({ name, args });
      return { content: 'Amar leads HIVEMIND, TARA, HYPERAGENTS' };
    },
  };
  const res = await runCompoundOrchestrator({
    subtasks: [
      { operation: 'recall', tool_groups: ['hivemind-recall'], depends_on: null, message: 'Recall Amar project details' },
    ],
    ctx,
    apiKey: 'k',
    signal: null,
  });
  assert.equal(res.status, 'completed');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].name, 'hivemind_recall');
  assert.ok(dispatched[0].args.query.includes('Amar'), 'recall query passed through');
});

test('compound orchestrator: normalizes google-docs to google_docs connector id', async () => {
  const seen = [];
  const runtime = makeRuntime({
    tools: [
      { name: 'google_docs__create', access: 'write', approval: 'never', allowedSurfaces: ['chat'], inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
    ],
    executeImpl: async (name, input) => {
      seen.push({ name, input });
      return { status: 'completed', content: [{ type: 'json', data: { doc_id: 'D1' } }], metadata: { connector: 'google_docs', tool: name } };
    },
  });
  // Wrap listTools to capture the connectors arg.
  const origList = runtime.listTools.bind(runtime);
  let listConnectors = null;
  runtime.listTools = async (ctx, opts) => { listConnectors = opts.connectors; return origList(ctx, opts); };
  globalThis.__hivemindConnectorRuntime = runtime;
  const ctx = { userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' }, _toolkit: null };

  const res = await runCompoundOrchestrator({
    subtasks: [
      { operation: 'create_doc', tool_groups: ['google-docs'], depends_on: null, message: 'create doc' },
    ],
    ctx,
    apiKey: 'k',
    signal: null,
    selectTool: makeSelector(() => ({ toolName: 'google_docs__create', args: { title: 'X' } })),
  });
  assert.equal(res.status, 'completed');
  assert.deepEqual(listConnectors, ['google_docs'], 'google-docs must normalize to google_docs');
  assert.equal(seen[0].name, 'google_docs__create');
});

test('compound orchestrator: emits tool_call/tool_result SSE events per subtask', async () => {
  const events = [];
  const runtime = makeRuntime({
    tools: [
      { name: 'gmail__search', access: 'read', approval: 'never', allowedSurfaces: ['chat'], inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    ],
    executeImpl: async (name, input) => ({ status: 'completed', content: [{ type: 'text', text: 'ok' }], metadata: { connector: 'gmail', tool: name } }),
  });
  globalThis.__hivemindConnectorRuntime = runtime;
  const ctx = { userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' }, _toolkit: null };

  const res = await runCompoundOrchestrator({
    subtasks: [
      { operation: 'search', tool_groups: ['gmail'], depends_on: null, message: 'search' },
    ],
    ctx,
    apiKey: 'k',
    signal: null,
    selectTool: makeSelector(() => ({ toolName: 'gmail__search', args: { query: 'x' } })),
    onEvent: (ev) => events.push(ev),
  });

  assert.equal(res.status, 'completed');
  const calls = events.filter((e) => e.type === 'tool_call');
  const results = events.filter((e) => e.type === 'tool_result');
  assert.equal(calls.length, 1, 'should emit one tool_call');
  assert.equal(calls[0].name, 'gmail__search');
  assert.equal(results.length, 1, 'should emit one tool_result');
  assert.equal(results[0].name, 'gmail__search');
  assert.equal(results[0].status, 'completed');
});

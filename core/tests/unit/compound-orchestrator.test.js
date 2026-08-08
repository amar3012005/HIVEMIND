import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolSelectionCards, runCompoundOrchestrator } from '../../src/agent/compound-orchestrator.js';

// ── Test harness ─────────────────────────────────────────────────────────────
// A deterministic tool-selector replaces the model call. The Composio service
// is stubbed via the `composio` override so no real API is hit.

function makeComposio({ tools, executeImpl }) {
  // tools: [{ name, slug, description }]
  return {
    async getToolkitTools() {
      return tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: { type: 'object', properties: {} } },
        _composio: { toolkit: 'mock', slug: t.slug },
      }));
    },
    async executeTool(orgId, slug, args) {
      return executeImpl(slug, args);
    },
  };
}

function makeSelector(pick) {
  return async ({ message }) => {
    const p = pick(message);
    if (!p) throw new Error('no tool selected');
    return { toolName: p.toolName, args: p.args || {}, schema: p.schema || { type: 'object', properties: {} } };
  };
}

test('compound orchestrator: semantic selection cards omit provider JSON schemas', () => {
  const cards = buildToolSelectionCards([{
    function: {
      name: 'GOOGLEDOCS_CREATE_DOCUMENT',
      description: 'Create a Google Document from supplied text.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  }]);
  assert.deepEqual(cards, [{ name: 'GOOGLEDOCS_CREATE_DOCUMENT', description: 'Create a Google Document from supplied text.' }]);
  assert.equal(JSON.stringify(cards).includes('parameters'), false);
  assert.equal(JSON.stringify(cards).includes('required'), false);
});

test('compound orchestrator: native hivemind-recall step runs via dispatchTool', async () => {
  const dispatched = [];
  const recallPacket = { content: 'Amar leads HIVEMIND', recall_packet: { citations: [{ id: 'C1' }], sourceSections: [{ segment_id: 'S1', content: 'full evidence' }] } };
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' },
    _tracedDispatch: async (name, args) => { dispatched.push({ name, args }); return recallPacket; },
  };
  const res = await runCompoundOrchestrator({
    subtasks: [{ operation: 'recall', tool_groups: ['hivemind-recall'], depends_on: null, message: 'Recall Amar' }],
    ctx, apiKey: 'k', signal: null,
  });
  assert.equal(res.status, 'completed');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].name, 'hivemind_recall');
  assert.equal(res.recallResults[0], recallPacket, 'full canonical recall result is retained without truncation');
});

test('compound orchestrator: composio read step executes and reports completed', async () => {
  const calls = [];
  const composio = makeComposio({
    tools: [{ name: 'composio_gmail_search', slug: 'GMAIL_SEARCH', description: 'search emails' }],
    executeImpl: async (slug, args) => { calls.push({ slug, args }); return { successful: true, data: { results: ['m1'] }, error: null }; },
  });
  const ctx = { userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' } };
  const res = await runCompoundOrchestrator({
    subtasks: [{ operation: 'search', tool_groups: ['gmail'], depends_on: null, message: 'search emails' }],
    ctx, apiKey: 'k', signal: null, composio,
    selectTool: makeSelector(() => ({ toolName: 'composio_gmail_search', args: { query: 'x' } })),
  });
  assert.equal(res.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].slug, 'GMAIL_SEARCH');
});

test('compound orchestrator: composio write creates a pendingWrite draft (never done)', async () => {
  const composio = makeComposio({
    tools: [{ name: 'composio_gmail_send_email', slug: 'GMAIL_SEND_EMAIL', description: 'send email' }],
    executeImpl: async () => ({ successful: true, data: {}, error: null }),
  });
  const created = [];
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' },
    prisma: { pendingWrite: { create: async (d) => { created.push(d.data); return { id: 'DRAFT1' }; } } },
  };
  const res = await runCompoundOrchestrator({
    subtasks: [{ operation: 'send_email', tool_groups: ['gmail'], depends_on: null, message: 'send email to boss' }],
    ctx, apiKey: 'k', signal: null, composio,
    selectTool: makeSelector(() => ({ toolName: 'composio_gmail_send_email', args: { to: 'boss@x.com' } })),
  });
  // A write must be reported as pending (draft), never done.
  assert.equal(res.status, 'pending');
  assert.equal(res.draftIds.length, 1);
  assert.equal(res.draftIds[0], 'DRAFT1');
  assert.equal(created.length, 1);
  assert.equal(created[0].toolName, 'GMAIL_SEND_EMAIL');
  assert.ok(res.summary.includes('awaiting your approval'));
  assert.ok(!res.summary.includes('done'));
});

test('compound orchestrator: a write missing a required provider field asks before creating a draft', async () => {
  const created = [];
  const composio = makeComposio({
    tools: [{ name: 'composio_googledocs_create', slug: 'GOOGLEDOCS_CREATE_DOCUMENT', description: 'create document' }],
    executeImpl: async () => ({ successful: true, data: {}, error: null }),
  });
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' },
    prisma: { pendingWrite: { create: async (d) => { created.push(d.data); return { id: 'DRAFT1' }; } } },
  };
  const res = await runCompoundOrchestrator({
    subtasks: [{ operation: 'write', tool_groups: ['google-docs'], depends_on: null, message: 'create a document titled Notes' }],
    ctx, apiKey: 'k', signal: null, composio,
    selectTool: makeSelector(() => ({
      toolName: 'composio_googledocs_create', args: { title: 'Notes' },
      schema: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['title', 'text'] },
    })),
  });
  assert.equal(res.status, 'needs_input');
  assert.equal(created.length, 0);
  assert.match(res.steps[0].summary, /text/i);
});

test('compound orchestrator: dependent subtask receives prior typed output fields', async () => {
  const calls = [];
  const composio = makeComposio({
    tools: [
      { name: 'composio_googledocs_get_document', slug: 'GOOGLEDOCS_GET_DOCUMENT', description: 'get document' },
      { name: 'composio_gmail_send_email', slug: 'GMAIL_SEND_EMAIL', description: 'send email' },
    ],
    executeImpl: async (slug, args) => {
      calls.push({ slug, args });
      if (slug === 'GOOGLEDOCS_GET_DOCUMENT') return { successful: true, data: { documentId: 'DOC123', url: 'https://docs/x' }, error: null };
      return { successful: true, data: {}, error: null };
    },
  });
  const created = [];
  const ctx = {
    userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' },
    prisma: { pendingWrite: { create: async (d) => { created.push(d.data); return { id: 'D1' }; } } },
  };
  const res = await runCompoundOrchestrator({
    subtasks: [
      { operation: 'create_doc', tool_groups: ['google-docs'], depends_on: null, message: 'create doc' },
      { operation: 'send_email', tool_groups: ['gmail'], depends_on: [0], message: 'email it' },
    ],
    ctx, apiKey: 'k', signal: null, composio,
    selectTool: makeSelector((m) => m.startsWith('create')
      ? { toolName: 'composio_googledocs_get_document', args: { id: 'x' }, schema: { type: 'object', properties: { id: { type: 'string' } } } }
      : { toolName: 'composio_gmail_send_email', args: { to: 'boss@x.com' }, schema: { type: 'object', properties: { documentId: { type: 'string' }, url: { type: 'string' }, to: { type: 'string' } } } }),
  });
  assert.equal(res.status, 'pending');
  // The email draft must have received documentId injected from the prior step.
  const draft = created.find((d) => d.toolName === 'GMAIL_SEND_EMAIL');
  assert.ok(draft, 'email draft created');
  assert.equal(draft.toolArgs.documentId, 'DOC123', 'documentId injected from prior result');
  assert.equal(draft.toolArgs.to, 'boss@x.com', 'explicit args preserved');
});

test('compound orchestrator: independent subtasks run in parallel (fan-out)', async () => {
  const calls = [];
  const composio = makeComposio({
    tools: [
      { name: 'composio_github_list', slug: 'GITHUB_LIST', description: 'list issues' },
      { name: 'composio_linear_list', slug: 'LINEAR_LIST', description: 'list tickets' },
    ],
    executeImpl: async (slug, args) => {
      calls.push({ slug, t: Date.now() });
      await new Promise((r) => setTimeout(r, 200));
      return { successful: true, data: {}, error: null };
    },
  });
  const ctx = { userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' } };
  const t0 = Date.now();
  const res = await runCompoundOrchestrator({
    subtasks: [
      { operation: 'github', tool_groups: ['github'], depends_on: null, message: 'check github' },
      { operation: 'linear', tool_groups: ['linear'], depends_on: null, message: 'check linear' },
    ],
    ctx, apiKey: 'k', signal: null, composio,
    selectTool: makeSelector((m) => m.includes('github') ? { toolName: 'composio_github_list', args: {} } : { toolName: 'composio_linear_list', args: {} }),
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.status, 'completed');
  assert.equal(calls.length, 2);
  const delta = Math.abs(calls[0].t - calls[1].t);
  assert.ok(delta < 100, `github+linear should start together (delta ${delta}ms)`);
  assert.ok(elapsed < 350, `fan-out should be ~200ms not ~400ms (got ${elapsed}ms)`);
});

test('compound orchestrator: emits tool_call/tool_result SSE events', async () => {
  const events = [];
  const composio = makeComposio({
    tools: [{ name: 'composio_gmail_search', slug: 'GMAIL_SEARCH', description: 'search' }],
    executeImpl: async () => ({ successful: true, data: {}, error: null }),
  });
  const ctx = { userId: 'u1', orgId: 'o1', _trace: { traceId: 't1' } };
  const res = await runCompoundOrchestrator({
    subtasks: [{ operation: 'search', tool_groups: ['gmail'], depends_on: null, message: 'search' }],
    ctx, apiKey: 'k', signal: null, composio,
    selectTool: makeSelector(() => ({ toolName: 'composio_gmail_search', args: {} })),
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(res.status, 'completed');
  assert.equal(events.filter((e) => e.type === 'tool_call').length, 1);
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDurableComposioAgent } from '../../src/agent/durable-composio-agent.js';
import { reconcileProgressiveApproval } from '../../src/agent/progressive-approval-events.js';

function fixture({ kind = 'lookup', slugs = ['NOTION_GET_PAGE', 'NOTION_SEARCH'], required = [] } = {}) {
  const rows = new Map();
  const writes = [];
  const executed = [];
  const prisma = { agentRun: {
    create: async ({ data }) => {
      const key = JSON.stringify({ orgId: data.orgId, conversationId: data.conversationId });
      if (rows.has(key)) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
      const row = { ...data, updatedAt: new Date() };
      rows.set(key, structuredClone(row));
      return structuredClone(row);
    },
    findFirst: async ({ where }) => structuredClone([...rows.values()].find(row => Object.entries(where).every(([key, value]) => row[key] === value)) || null),
    updateMany: async ({ where, data }) => {
      const row = [...rows.values()].find(row => row.id === where.id && row.orgId === where.orgId && row.userId === where.userId);
      if (!row || (where.updatedAt && +new Date(row.updatedAt) !== +new Date(where.updatedAt))
        || (where.scratch && row.scratch?.lease?.owner !== where.scratch.equals)) return { count: 0 };
      Object.assign(row, structuredClone(data), { updatedAt: new Date(Math.max(Date.now(), +new Date(row.updatedAt) + 1)) });
      return { count: 1 };
    },
    findUnique: async ({ where }) => structuredClone(rows.get(JSON.stringify(where.orgId_conversationId)) || null),
    upsert: async ({ where, create, update }) => {
      const key = JSON.stringify(where.orgId_conversationId);
      const row = rows.has(key) ? { ...rows.get(key), ...update } : create;
      rows.set(key, structuredClone(row));
      return structuredClone(row);
    },
  }, pendingWrite: { create: async ({ data }) => { writes.push(data); return { id: `draft-${writes.length}` }; } } };
  const schema = { type: 'object', additionalProperties: false, properties: { title: { type: 'string' } }, required };
  const composio = {
    listConnectedAccounts: async () => [{ toolkit: 'notion', status: 'ACTIVE' }],
    discoverSessionTools: async () => ({ sessionId: 'session-tenant', workflowSessionId: 'workflow-1',
      tools: slugs.map(slug => ({ type: 'function', function: { name: `composio_${slug}`.toLowerCase(), parameters: schema }, _composio: { slug, toolkit: 'notion' } })),
      toolSchemas: Object.fromEntries(slugs.map(slug => [slug, { toolkit: 'notion', description: slug, input_schema: schema }])) }),
    executeToolsParallel: async (org, calls, options) => {
      assert.equal(org, 'tenant-progressive');
      assert.equal(options.allowDirectFallback, false);
      executed.push(...calls);
      return calls.map(call => ({ successful: true, data: { text: `Evidence from ${call.slug}` } }));
    },
  };
  const ctx = { orgId: 'tenant-progressive', userId: 'user-1', threadId: 'thread-1', prisma,
    localizeProgressiveStatus: async text => text,
    resolveHarnessIntent: async () => ({ kind, apps: ['notion'], person: '', use_case: 'retrieve workspace pages', known_fields: '', language: 'de', needs_memory: true,
      outcomes: kind === 'compose' ? [{ id: 'd1', description: 'Prepare page', kind: 'draft' }] : [
        { id: 'm1', description: 'Recall internal context', kind: 'memory' },
        { id: 'r1', description: 'Read page', kind: 'read' }, { id: 'r2', description: 'Search pages', kind: 'read' }] }),
    generateProgressiveToolInputs: async () => ({}),
    synthesizeDurableAnswer: async ({ reads, messages }) => {
      assert.equal(JSON.parse(messages[1].content).language, 'de');
      return `Found ${reads.length} records.`;
    },
  };
  return { prisma, composio, ctx, writes, executed, rows };
}

async function enabled(fn) {
  const prior = [process.env.USE_TOOLS_PROGRESSIVE_HARNESS, process.env.USE_TOOLS_PROGRESSIVE_HARNESS_ORGS];
  process.env.USE_TOOLS_PROGRESSIVE_HARNESS = 'true';
  process.env.USE_TOOLS_PROGRESSIVE_HARNESS_ORGS = 'tenant-progressive';
  try { return await fn(); } finally {
    for (const [i, key] of ['USE_TOOLS_PROGRESSIVE_HARNESS', 'USE_TOOLS_PROGRESSIVE_HARNESS_ORGS'].entries()) {
      if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i];
    }
  }
}

const actions = (...items) => async () => {
  const next = items.shift() || { action: 'done', reason: 'All requested evidence obtained' };
  return { ...next, outcome_ids: next.outcome_ids || (next.action === 'draft' ? ['d1'] : next.action === 'native' ? ['m1'] : next.action === 'execute' ? [next.slug === 'NOTION_SEARCH' ? 'r2' : 'r1'] : []) };
};
const search = { action: 'search', query: 'retrieve workspace pages', reason: 'Discover relevant capability' };

test('default progressive model transport POSTs JSON for intent, action, arguments, synthesis and pause localization', () => enabled(async () => {
  const originalFetch = globalThis.fetch;
  const envNames = ['OPENROUTER_API_KEY', 'CLOUDFLARE_AI_GATEWAY_ENABLED', 'DURABLE_NEXT_ACTION_MODEL', 'HIVEMIND_BRIEFING_MODEL'];
  const originalEnv = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
  const requests = [];
  const replies = [];
  process.env.OPENROUTER_API_KEY = 'fixture-not-a-real-key';
  process.env.CLOUDFLARE_AI_GATEWAY_ENABLED = 'false';
  process.env.DURABLE_NEXT_ACTION_MODEL = 'google/gemini-2.5-flash-lite';
  process.env.HIVEMIND_BRIEFING_MODEL = 'google/gemini-2.5-flash-lite';
  globalThis.fetch = async (_url, options = {}) => {
    // Stub only the HTTP boundary: use the actual non-injected model callers
    // and shared chatCompletionFetch transport. Never make a network request.
    const body = JSON.parse(options.body);
    requests.push({ method: options.method, body });
    assert.ok(replies.length, 'Unexpected model request');
    const reply = replies.shift();
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const defaultModels = f => {
    for (const key of ['resolveHarnessIntent', 'chooseNextAction', 'generateProgressiveToolInputs', 'synthesizeDurableAnswer', 'localizeProgressiveStatus']) delete f.ctx[key];
    return f;
  };
  const intent = kind => ({ kind, apps: ['notion'], person: '', use_case: 'retrieve workspace page', known_fields: '', language: 'de', needs_memory: false,
    outcomes: [{ id: 'page', description: kind === 'lookup' ? 'Read page' : 'Prepare page', kind: kind === 'lookup' ? 'read' : 'draft' }] });
  try {
    const read = defaultModels(fixture({ slugs: ['NOTION_GET_PAGE'] }));
    replies.push(intent('lookup'), search, { action: 'execute', slug: 'NOTION_GET_PAGE', reason: 'Read requested page', outcome_ids: ['page'] }, {},
      { action: 'done', reason: 'Requested page read' }, 'Die Seite wurde gefunden.');
    const completed = await runDurableComposioAgent({ message: 'Lies die Seite', ...read });
    assert.equal(completed.status, 'completed', completed.summary);
    assert.equal(completed.summary, 'Die Seite wurde gefunden.');
    assert.equal(read.executed.length, 1);
    assert.equal(replies.length, 0);

    const compose = defaultModels(fixture({ kind: 'compose', slugs: ['NOTION_CREATE_PAGE'], required: ['title'] }));
    replies.push(intent('compose'), search, { action: 'draft', slug: 'NOTION_CREATE_PAGE', reason: 'Prepare page', outcome_ids: ['page'] }, {},
      'Bitte geben Sie title an.');
    const paused = await runDurableComposioAgent({ message: 'Erstelle eine Seite', ...compose });
    assert.equal(paused.status, 'needs_input', paused.summary);
    assert.equal(paused.summary, 'Bitte geben Sie title an.');
    assert.equal(compose.writes.length, 0);
    assert.equal(replies.length, 0);
    assert.equal(requests.length, 11);
    // Check afterward too: localization deliberately catches errors, so an
    // assertion only inside fetch could be swallowed by the fallback.
    for (const request of requests) {
      assert.equal(request.method, 'POST', request.body.messages[0].content.slice(0, 100));
      assert.ok(Array.isArray(request.body.messages) && request.body.messages.length >= 2);
      assert.equal(typeof request.body.model, 'string');
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envNames) {
      if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
    }
  }
}));

test('progressive multi-read persists receipts and preserves native evidence in synthesis', () => enabled(async () => {
  const f = fixture();
  f.ctx._dispatchTool = async () => ({ summary: 'Internal project context' });
  f.ctx.chooseNextAction = actions(search, { action: 'native', slug: 'HIVEMIND_RECALL', reason: 'Need internal context' },
    { action: 'execute', slug: 'NOTION_GET_PAGE', reason: 'First requested outcome' },
    { action: 'execute', slug: 'NOTION_SEARCH', reason: 'Second requested outcome' });
  const result = await runDurableComposioAgent({ message: 'Vergleiche interne und externe Informationen', ...f });
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(result.run.scratch.harness_version, 'progressive-v1');
  assert.equal(f.executed.length, 2);
  assert.equal(result.run.scratch.read_results.length, 3);
  assert.equal([...f.rows.values()][0].status, 'done');
}));

test('generic write drafts schema fields without demanding email', () => enabled(async () => {
  const f = fixture({ kind: 'compose', slugs: ['NOTION_CREATE_PAGE'], required: ['title'] });
  f.ctx.generateProgressiveToolInputs = async () => ({ title: 'Projektplan' });
  f.ctx.chooseNextAction = actions(search, { action: 'draft', slug: 'NOTION_CREATE_PAGE', reason: 'Prepare requested page' });
  const result = await runDurableComposioAgent({ message: 'Erstelle eine Seite', ...f });
  assert.equal(result.status, 'pending', result.summary);
  assert.equal(f.executed.length, 0);
  assert.equal(f.writes[0].toolArgs.title, 'Projektplan');
  assert.equal(f.writes[0].toolArgs._harness_version, 'progressive-v1');
  assert.deepEqual(f.writes[0].toolArgs._input_schema.required, ['title']);
  assert.equal(f.writes[0].toolArgs.to, undefined);
  assert.equal(f.writes[0].status, 'draft');
}));

test('missing schema input resumes same durable run even after feature flag is disabled', () => enabled(async () => {
  const f = fixture({ kind: 'compose', slugs: ['NOTION_CREATE_PAGE'], required: ['title'] });
  f.ctx.chooseNextAction = actions(search, { action: 'draft', slug: 'NOTION_CREATE_PAGE', reason: 'Prepare page' });
  const first = await runDurableComposioAgent({ message: 'Create page', ...f });
  assert.equal(first.status, 'needs_input', first.summary);
  assert.equal(first.inputRequests[0].fields[0].id, 'title');
  process.env.USE_TOOLS_PROGRESSIVE_HARNESS = 'false';
  f.ctx.chooseNextAction = actions({ action: 'draft', slug: 'NOTION_CREATE_PAGE', reason: 'User supplied title' });
  const resumed = await runDurableComposioAgent({ message: 'Create page', choice: { values: { title: 'Given title' } }, ...f });
  assert.equal(resumed.run.id, first.run.id);
  assert.equal(resumed.run.scratch.harness_version, 'progressive-v1');
  assert.equal(resumed.status, 'pending', resumed.summary);
  assert.equal(f.writes.length, 1);
}));

test('model cannot authorize an unknown or write capability as a read', () => enabled(async () => {
  for (const slug of ['NOTION_DELETE_PAGE', 'NOTION_MAGIC', 'NOTION_UNDISCOVERED']) {
    const f = fixture({ slugs: ['NOTION_DELETE_PAGE', 'NOTION_MAGIC'] });
    f.ctx.chooseNextAction = actions(search, { action: 'execute', slug, reason: 'Model claims this is a read' });
    const result = await runDurableComposioAgent({ message: 'Read page', ...f });
    assert.equal(result.status, 'error');
    assert.equal(f.executed.length, 0);
    assert.equal(f.writes.length, 0);
  }
}));

test('read-only intent cannot draft; compose cannot finish without a persisted draft', () => enabled(async () => {
  for (const kind of ['lookup', 'compose']) {
    const f = fixture({ kind, slugs: ['NOTION_CREATE_PAGE'] });
    f.ctx.chooseNextAction = kind === 'lookup' ? actions(search, { action: 'draft', slug: 'NOTION_CREATE_PAGE', reason: 'Mutate' }) : actions();
    const result = await runDurableComposioAgent({ message: 'Request', ...f });
    assert.equal(result.status, 'error');
    assert.equal(f.writes.length, 0);
  }
}));

test('planner error, unavailable persistence and budget exhaustion fail honestly', () => enabled(async () => {
  const f = fixture();
  f.ctx.chooseNextAction = async () => { throw new Error('model unavailable'); };
  const failed = await runDurableComposioAgent({ message: 'Read', ...f });
  assert.equal(failed.status, 'error');
  assert.match(failed.summary, /service failed/);
  const missing = fixture();
  delete missing.ctx.prisma;
  const blocked = await runDurableComposioAgent({ message: 'Read', ctx: missing.ctx, composio: missing.composio });
  assert.equal(blocked.status, 'error');
  assert.match(blocked.summary, /persistent storage/);
  const looping = fixture();
  looping.ctx.chooseNextAction = async () => search;
  const exhausted = await runDurableComposioAgent({ message: 'Read', ...looping });
  assert.equal(exhausted.status, 'error');
  assert.match(exhausted.summary, /budget exhausted/);
}));

test('one successful read cannot satisfy remaining declared outcomes', () => enabled(async () => {
  const f = fixture();
  f.ctx.chooseNextAction = actions(search, { action: 'execute', slug: 'NOTION_GET_PAGE', reason: 'Read page' });
  const result = await runDurableComposioAgent({ message: 'Read page and search pages', ...f });
  assert.equal(result.status, 'error');
  assert.match(result.summary, /outcomes remain unresolved/);
  assert.equal(f.executed.length, 1);
}));

test('two requested drafts finish only when both persisted receipts exist', () => enabled(async () => {
  const f = fixture({ kind: 'compose', slugs: ['NOTION_CREATE_PAGE'], required: ['title'] });
  const intent = await f.ctx.resolveHarnessIntent();
  f.ctx.resolveHarnessIntent = async () => ({ ...intent, outcomes: [
    { id: 'd1', description: 'First page', kind: 'draft' }, { id: 'd2', description: 'Second page', kind: 'draft' }] });
  let count = 0;
  f.ctx.generateProgressiveToolInputs = async () => ({ title: `Page ${++count}` });
  f.ctx.chooseNextAction = actions(search,
    { action: 'draft', slug: 'NOTION_CREATE_PAGE', reason: 'First page', outcome_ids: ['d1'] },
    { action: 'draft', slug: 'NOTION_CREATE_PAGE', reason: 'Second page', outcome_ids: ['d2'] });
  const result = await runDurableComposioAgent({ message: 'Create two pages', ...f });
  assert.equal(result.status, 'pending', result.summary);
  assert.equal(result.run.scratch.outcomes_complete, true);
  assert.equal(result.draftIds.length, 2);
  assert.equal(f.writes.length, 2);
  assert.equal(f.executed.length, 0);
}));

test('failure after a persisted draft retains pending state and draft IDs', () => enabled(async () => {
  const f = fixture({ kind: 'compose', slugs: ['NOTION_CREATE_PAGE'] });
  const intent = await f.ctx.resolveHarnessIntent();
  f.ctx.resolveHarnessIntent = async () => ({ ...intent, outcomes: [
    ...intent.outcomes, { id: 'r1', description: 'Read another page', kind: 'read' }] });
  f.ctx.chooseNextAction = actions(search, { action: 'draft', slug: 'NOTION_CREATE_PAGE', reason: 'Prepare first outcome' });
  const result = await runDurableComposioAgent({ message: 'Create and read', ...f });
  assert.equal(result.status, 'pending');
  assert.equal(result.run.status, 'waiting_approval');
  assert.equal(result.draftIds.length, 1);
  assert.match(result.summary, /remaining outcomes are incomplete/);
}));

test('fabricated empty schema and suffix read names never grant read execution', () => enabled(async () => {
  for (const shape of ['missing-schema', 'suffix-read']) {
    const slug = shape === 'suffix-read' ? 'NOTION_SETTINGS_GET' : 'NOTION_GET_PAGE';
    const f = fixture({ slugs: [slug] });
    const discover = f.composio.discoverSessionTools;
    if (shape === 'missing-schema') f.composio.discoverSessionTools = async () => ({ ...await discover(), toolSchemas: {} });
    f.ctx.chooseNextAction = actions(search, { action: 'execute', slug, reason: 'Read' });
    const result = await runDurableComposioAgent({ message: 'Read', ...f });
    assert.equal(result.status, 'error');
    assert.equal(f.executed.length, 0);
  }
}));

test('cancelled requests do not start connector calls', () => enabled(async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  f.ctx._signal = controller.signal;
  f.composio.listConnectedAccounts = async () => { assert.fail('cancelled turn must not reach connectors'); };
  const result = await runDurableComposioAgent({ message: 'Read', ...f });
  assert.equal(result.status, 'error');
  assert.match(result.summary, /cancelled/);
}));

test('approval projected during active execution survives checkpoint and settles at release', () => enabled(async () => {
  const f = fixture({ kind: 'compose', slugs: ['NOTION_CREATE_PAGE'] });
  f.prisma.pendingWrite.findFirst = async ({ where }) => {
    const row = f.writes.map((data, index) => ({ ...data, id: `draft-${index + 1}` }))
      .find(data => Object.entries(where).every(([key, value]) => data[key] === value));
    return row || null;
  };
  let index = 0;
  f.ctx.chooseNextAction = async () => {
    if (index++ === 0) return search;
    if (index === 2) return { action: 'draft', slug: 'NOTION_CREATE_PAGE', reason: 'Prepare page', outcome_ids: ['d1'] };
    f.writes[0].status = 'sent';
    const projected = await reconcileProgressiveApproval({ prisma: f.prisma, draft: { ...f.writes[0], id: 'draft-1' } });
    assert.equal(projected.status, 'running');
    return { action: 'done', reason: 'Requested preparation completed' };
  };
  const result = await runDurableComposioAgent({ message: 'Create page', ...f });
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(result.run.status, 'done');
  assert.equal(result.run.scratch.approvals['draft-1'].status, 'sent');
  assert.equal(result.run.steps.filter(step => step.kind === 'approval').length, 1);
}));

test('compose-only outcome permits prerequisite reads without claiming outcome coverage', () => enabled(async () => {
  const f = fixture({ kind: 'compose', slugs: ['NOTION_GET_PAGE', 'NOTION_CREATE_PAGE'] });
  f.ctx.chooseNextAction = actions(search,
    { action: 'execute', slug: 'NOTION_GET_PAGE', reason: 'Read facts needed for the requested draft', outcome_ids: [] },
    { action: 'draft', slug: 'NOTION_CREATE_PAGE', reason: 'Prepare requested draft with the retrieved facts', outcome_ids: ['d1'] });
  const result = await runDurableComposioAgent({ message: 'Prepare a page based on the current project', ...f });
  assert.equal(result.status, 'pending', result.summary);
  assert.equal(f.executed.length, 1);
  assert.deepEqual(result.run.scratch.read_results[0].outcome_ids, []);
  assert.deepEqual(result.run.scratch.draft_receipts[0].outcome_ids, ['d1']);
  assert.equal(result.run.scratch.outcomes_complete, true);
  assert.equal(result.draftIds.length, 1);
}));

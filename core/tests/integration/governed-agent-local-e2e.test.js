import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySaver } from '@langchain/langgraph';
import { runGovernedAgentRuntime } from '../../src/agent/governed-agent-runtime.js';
import { evaluateGovernedOutput } from '../../src/evaluation/governed-agent-evaluators.js';

const UUID = () => crypto.randomUUID();

function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object' && value.gt) return new Date(row[key]).getTime() > new Date(value.gt).getTime();
    return row[key] === value;
  });
}

function fakePrisma() {
  const runs = new Map();
  const drafts = [];
  const events = new Map();
  const bindings = new Map();
  const bindingKey = ({ orgId, userId, connectionScope }) => `${orgId}:${userId}:${connectionScope}`;
  return {
    runs, drafts, events, bindings,
    agentRun: {
      async create({ data }) { const row = { ...data }; runs.set(row.id, row); return row; },
      async update({ where, data }) { const row = { ...(runs.get(where.id) || {}), ...data, id: where.id }; runs.set(where.id, row); return row; },
      async findFirst({ where }) { return [...runs.values()].find(row => matches(row, where)) || null; },
    },
    pendingWrite: {
      async findFirst({ where }) { return drafts.find(row => matches(row, where)) || null; },
      async create({ data }) { const row = { id: UUID(), ...data }; drafts.push(row); return row; },
      async update({ where, data }) { const row = drafts.find(item => item.id === where.id); Object.assign(row, data); return row; },
      async updateMany({ where, data }) { const rows = drafts.filter(row => matches(row, where)); rows.forEach(row => Object.assign(row, data)); return { count: rows.length }; },
    },
    governedAgentEvent: {
      async create({ data }) {
        const key = `${data.orgId}:${data.idempotencyKey}`;
        if (events.has(key)) { const error = new Error('duplicate'); error.code = 'P2002'; throw error; }
        events.set(key, data); return data;
      },
      async findFirst({ where }) { return events.get(`${where.orgId}:${where.idempotencyKey}`) || null; },
    },
    governedComposioSession: {
      async findUnique({ where }) { return bindings.get(bindingKey(where.orgId_userId_connectionScope)) || null; },
      async upsert({ where, create, update }) {
        const key = bindingKey(where.orgId_userId_connectionScope);
        const row = { ...(bindings.get(key) || create), ...(bindings.has(key) ? update : {}) };
        bindings.set(key, row);
        return row;
      },
    },
  };
}

function tool(toolkit, slug, parameters) {
  return { _composio: { toolkit, slug }, function: { description: slug, parameters } };
}

function mockComposio({ toolkit, tools, execute, accounts = null }) {
  const calls = [];
  return {
    calls,
    async listConnectedAccounts() { return accounts || [{ toolkit, status: 'ACTIVE' }]; },
    async discoverSessionTools(_orgId, input) {
      calls.push({ kind: 'discover', query: input.useCases?.[0] || null });
      return {
        sessionId: `trs-${toolkit}-user`, workflowSessionId: `workflow-${toolkit}-user`, tools,
        toolSchemas: Object.fromEntries(tools.map(item => [item._composio.slug, {
          toolkit, description: item._composio.slug, input_schema: item.function.parameters,
        }])),
        toolkitConnectionStatuses: { [toolkit]: { status: 'ACTIVE' } },
        recommendedPlanSteps: [{ action: 'select the capability with evidence-backed arguments' }],
        nextStepsGuidance: 'Resolve dependencies before a governed draft.',
        primaryToolSlugs: tools.map(item => item._composio.slug), relatedToolSlugs: [],
        searchStrategy: input.searchPayload?.search_strategy || 'tool_search',
      };
    },
    async executeToolsParallel(_orgId, callsInput) {
      return callsInput.map(call => {
        calls.push({ kind: 'execute', slug: call.slug, arguments: call.arguments });
        return execute(call.slug, call.arguments);
      });
    },
    async manageSessionConnections() { return { successful: true, redirectUrl: `https://auth.example.test/${toolkit}` }; },
  };
}

function runtimeInput({ message, language, threadId, decision, composio, prisma, checkpointer, choice = null, run = null }) {
  return runGovernedAgentRuntime({
    message,
    ctx: {
      orgId: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000002',
      language, threadId, historyTurns: 3,
      governedDecision: decision,
      ...(run ? { governedGraphThreadId: run.resumeState.graph_thread_id, governedRunId: run.run.id } : {}),
    },
    composio, prisma, checkpointer, choice,
  });
}

test('local E2E: one graph handles English, German, and French self-data reads with receipt-backed completion', async () => {
  const cases = [
    ['en', 'What is my LinkedIn profile?'],
    ['de', 'Wie lautet mein LinkedIn-Profil?'],
    ['fr', 'Quel est mon profil LinkedIn ?'],
  ];
  for (const [locale, message] of cases) {
    const prisma = fakePrisma();
    const profile = tool('linkedin', 'LINKEDIN_GET_MY_INFO', { type: 'object', properties: {} });
    const composio = mockComposio({
      toolkit: 'linkedin', tools: [profile],
      execute: slug => ({ successful: slug === 'LINKEDIN_GET_MY_INFO', data: { profile: { headline: 'Governed agent builder' } } }),
    });
    const result = await runtimeInput({
      message, language: locale, threadId: `profile-${locale}`, composio, prisma, checkpointer: new MemorySaver(),
      decision: async ({ stage }) => {
        if (stage === 'intent') return {
          locale, kind: 'read', apps: ['linkedin'], discovery_query: 'read the authenticated professional profile',
          outcomes: [{ id: 'profile', kind: 'read', description: 'authenticated profile' }], known_facts: {},
        };
        if (stage === 'planning') return { action: 'read', tool_slug: 'LINKEDIN_GET_MY_INFO', outcome_ids: ['profile'], reason: 'read authenticated profile' };
        if (stage === 'arguments') return {};
        if (stage === 'synthesis') return { response: `profile response in ${locale}` };
        throw new Error(`unexpected stage ${stage}`);
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.locale, locale);
    assert.equal(result.inputRequests?.length || 0, 0);
    assert.ok(result.steps.some(step => step.slug === 'LINKEDIN_GET_MY_INFO' && step.status === 'completed'));
    assert.ok([...prisma.events.values()].some(event => event.payload?.state === 'sealed'));
    const scores = evaluateGovernedOutput({ status: result.status, locale: result.locale, response: result.response, trajectory: result.steps }, {
      locale, terminal: ['completed'], required_tools: ['COMPOSIO_SEARCH_TOOLS', 'LINKEDIN_GET_MY_INFO'], requires_receipt: true,
    });
    assert.ok(scores.every(score => score.score === 1), JSON.stringify(scores));
  }
});

test('local E2E: a dependent latest-post request resolves a provider identifier from a read receipt', async () => {
  const prisma = fakePrisma();
  const listPosts = tool('linkedin', 'LINKEDIN_LIST_POSTS', { type: 'object', properties: {} });
  const getPost = tool('linkedin', 'LINKEDIN_GET_POST_CONTENT', {
    type: 'object', properties: { post_urn: { type: 'string' } }, required: ['post_urn'], additionalProperties: false,
  });
  const composio = mockComposio({
    toolkit: 'linkedin', tools: [listPosts, getPost],
    execute: (slug, args) => slug === 'LINKEDIN_LIST_POSTS'
      ? { successful: true, data: { posts: [{ urn: 'urn:li:share:123' }] } }
      : { successful: args.post_urn === 'urn:li:share:123', data: { content: 'A governed-agent update.' } },
  });
  const result = await runtimeInput({
    message: 'What is my latest LinkedIn post about?', language: 'en', threadId: 'latest-post', composio, prisma, checkpointer: new MemorySaver(),
    decision: async ({ stage, input }) => {
      if (stage === 'intent') return {
        locale: 'en', kind: 'read', apps: ['linkedin'], discovery_query: 'find and read the latest post for the authenticated member',
        outcomes: [{ id: 'latest_post', kind: 'read', description: 'latest professional post' }], known_facts: {},
      };
      if (stage === 'planning') return input.receipts.some(row => row.slug === 'LINKEDIN_LIST_POSTS')
        ? { action: 'read', tool_slug: 'LINKEDIN_GET_POST_CONTENT', outcome_ids: ['latest_post'], reason: 'read the latest listed post' }
        : { action: 'read', tool_slug: 'LINKEDIN_LIST_POSTS', purpose: 'prerequisite', reason: 'resolve latest post identifier' };
      if (stage === 'arguments') return input.selected_capability.slug === 'LINKEDIN_LIST_POSTS' ? {} : { post_urn: 'urn:li:share:123' };
      if (stage === 'synthesis') return { response: 'Your latest post is about a governed-agent update.' };
      throw new Error(`unexpected stage ${stage}`);
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.inputRequests?.length || 0, 0);
  assert.deepEqual(composio.calls.filter(call => call.kind === 'execute').map(call => call.slug), ['LINKEDIN_LIST_POSTS', 'LINKEDIN_GET_POST_CONTENT']);
});

test('local E2E: an OAuth connection interrupt resumes the same graph/session after connection evidence appears', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  let connected = false;
  const fetchEmails = tool('gmail', 'GMAIL_FETCH_EMAILS', { type: 'object', properties: {} });
  const composio = mockComposio({
    toolkit: 'gmail', tools: [fetchEmails], accounts: [],
    execute: slug => ({ successful: slug === 'GMAIL_FETCH_EMAILS', data: { messages: [{ subject: 'Welcome' }] } }),
  });
  composio.listConnectedAccounts = async () => connected ? [{ toolkit: 'gmail', status: 'ACTIVE' }] : [];
  const originalDiscover = composio.discoverSessionTools.bind(composio);
  composio.discoverSessionTools = async (orgId, input) => {
    const result = await originalDiscover(orgId, input);
    result.toolkitConnectionStatuses = { gmail: { status: connected ? 'ACTIVE' : 'INITIATED' } };
    return result;
  };
  const decision = async ({ stage }) => {
    if (stage === 'intent') return {
      locale: 'en', kind: 'read', apps: ['gmail'], discovery_query: 'read the latest messages for the authenticated mailbox',
      outcomes: [{ id: 'latest', kind: 'read', description: 'latest email messages' }], known_facts: {},
    };
    if (stage === 'planning') return { action: 'read', tool_slug: 'GMAIL_FETCH_EMAILS', outcome_ids: ['latest'], reason: 'read authenticated mailbox' };
    if (stage === 'arguments') return {};
    if (stage === 'synthesis') return { response: 'Your latest email is Welcome.' };
    throw new Error(`unexpected stage ${stage}`);
  };
  const paused = await runtimeInput({
    message: 'What is my latest email?', language: 'en', threadId: 'oauth-resume', decision, composio, prisma, checkpointer,
  });
  assert.equal(paused.status, 'needs_input');
  assert.equal(paused.inputRequests[0].kind, 'connect_account');
  assert.equal(paused.inputRequests[0].options[0].href, 'https://auth.example.test/gmail');
  const originalSession = paused.run.composioSessionId;

  connected = true;
  const completed = await runtimeInput({
    message: 'What is my latest email?', language: 'en', threadId: 'oauth-resume', decision, composio, prisma, checkpointer, run: paused,
    choice: { option_id: 'connected', value: 'retry_connection' },
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.run.composioSessionId, originalSession);
  assert.equal(composio.calls.filter(call => call.kind === 'execute' && call.slug === 'GMAIL_FETCH_EMAILS').length, 1);
});

test('local E2E: named-recipient draft resolves evidence, then approval and rejection remain exactly-once', async () => {
  const makeRun = async threadId => {
    const prisma = fakePrisma();
    let writes = 0;
    const people = tool('gmail', 'GMAIL_SEARCH_PEOPLE', {
      type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
    });
    const send = tool('gmail', 'GMAIL_SEND_EMAIL', {
      type: 'object', properties: { recipient_email: { type: 'string' }, body: { type: 'string' } }, required: ['recipient_email', 'body'], additionalProperties: false,
    });
    const composio = mockComposio({
      toolkit: 'gmail', tools: [people, send],
      execute: (slug, args) => {
        if (slug === 'GMAIL_SEARCH_PEOPLE') return { successful: args.query === 'Rama', data: { people: [{ email: 'rama@example.test' }] } };
        writes += 1;
        return { successful: args.recipient_email === 'rama@example.test', data: { message_id: `mock-${writes}` } };
      },
    });
    const decision = async ({ stage, input }) => {
      if (stage === 'intent') return {
        locale: 'en', kind: 'write', apps: ['gmail'], discovery_query: 'prepare an email draft for a named recipient about Singulance',
        outcomes: [{ id: 'draft', kind: 'draft', description: 'prepare the email draft' }], known_facts: { recipient_name: 'Rama' },
      };
      if (stage === 'planning') return input.receipts.some(row => row.slug === 'GMAIL_SEARCH_PEOPLE')
        ? { action: 'draft', tool_slug: 'GMAIL_SEND_EMAIL', outcome_ids: ['draft'], reason: 'draft with resolved evidence' }
        : { action: 'read', tool_slug: 'GMAIL_SEARCH_PEOPLE', purpose: 'prerequisite', reason: 'resolve named recipient' };
      if (stage === 'arguments') return input.selected_capability.slug === 'GMAIL_SEARCH_PEOPLE'
        ? { query: 'Rama' }
        : { recipient_email: 'rama@example.test', body: 'Singulance is ready.' };
      if (stage === 'synthesis') return { response: 'The approved draft was sent.' };
      throw new Error(`unexpected stage ${stage}`);
    };
    const checkpointer = new MemorySaver();
    const pending = await runtimeInput({ message: 'Send Rama an email about Singulance.', language: 'en', threadId, decision, composio, prisma, checkpointer });
    return { prisma, composio, decision, checkpointer, pending, get writes() { return writes; } };
  };

  const approved = await makeRun('rama-approve');
  assert.equal(approved.pending.status, 'pending');
  assert.equal(approved.writes, 0);
  assert.ok(approved.pending.steps.some(step => step.slug === 'GMAIL_SEARCH_PEOPLE' && step.status === 'completed'));
  const sent = await runtimeInput({
    message: 'Send Rama an email about Singulance.', language: 'en', threadId: 'rama-approve', decision: approved.decision,
    composio: approved.composio, prisma: approved.prisma, checkpointer: approved.checkpointer, run: approved.pending,
    choice: { action: 'approve', approval_id: approved.pending.draftIds[0] },
  });
  assert.equal(sent.status, 'completed');
  assert.equal(approved.writes, 1);
  assert.equal(approved.prisma.drafts[0].status, 'sent');

  const rejected = await makeRun('rama-reject');
  const cancelled = await runtimeInput({
    message: 'Send Rama an email about Singulance.', language: 'en', threadId: 'rama-reject', decision: rejected.decision,
    composio: rejected.composio, prisma: rejected.prisma, checkpointer: rejected.checkpointer, run: rejected.pending,
    choice: { action: 'reject', approval_id: rejected.pending.draftIds[0] },
  });
  assert.equal(cancelled.status, 'completed');
  assert.equal(rejected.writes, 0);
  assert.equal(rejected.prisma.drafts[0].status, 'cancelled');
});

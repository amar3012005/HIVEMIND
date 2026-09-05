import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySaver } from '@langchain/langgraph';
import {
  capabilityAuthority,
  missingRequiredFields,
  synthesisReceipt,
  verifyPlanCandidate,
} from '../../src/agent/governed-agent-contract.js';
import { GovernedAgentEventLedger } from '../../src/agent/governed-agent-event-ledger.js';
import { resumeGovernedProviderEvent, runGovernedAgentRuntime } from '../../src/agent/governed-agent-runtime.js';

function fakePrisma() {
  const runs = new Map();
  const drafts = [];
  const events = new Map();
  const bindings = new Map();
  const bindingKey = ({ orgId, userId, connectionScope }) => `${orgId}:${userId}:${connectionScope}`;
  return {
    runs,
    drafts,
    events,
    bindings,
    agentRun: {
      async create({ data }) { runs.set(data.id, { ...data }); return runs.get(data.id); },
      async update({ where, data }) { const row = { ...(runs.get(where.id) || {}), ...data, id: where.id }; runs.set(where.id, row); return row; },
      async findFirst({ where }) { return [...runs.values()].find(row => Object.entries(where).every(([key, value]) => row[key] === value)) || null; },
    },
    pendingWrite: {
      async findFirst({ where }) { return drafts.find(row => Object.entries(where).every(([key, value]) => row[key] === value)) || null; },
      async create({ data }) { const row = { id: `draft-${drafts.length + 1}`, ...data }; drafts.push(row); return row; },
      async updateMany({ where = {}, data = {} }) {
        const rows = drafts.filter(row => Object.entries(where).every(([key, value]) => {
          if (value && typeof value === 'object' && value.gt) return new Date(row[key]).getTime() > new Date(value.gt).getTime();
          return row[key] === value;
        }));
        rows.forEach(row => Object.assign(row, data));
        return { count: rows.length };
      },
      async update({ where, data }) { const row = drafts.find(item => item.id === where.id); Object.assign(row, data); return row; },
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

function tool(slug, schema) {
  return { _composio: { slug, toolkit: 'gmail' }, function: { description: slug, parameters: schema } };
}

function composioWith(tools) {
  return {
    async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }]; },
    async discoverSessionTools(_orgId, input) {
      return {
        sessionId: 'trs-user-session',
        workflowSessionId: 'workflow-user-session',
        tools,
        toolSchemas: Object.fromEntries(tools.map(row => [row._composio.slug, { toolkit: 'gmail', description: row._composio.slug, input_schema: row.function.parameters }])),
        toolkitConnectionStatuses: { gmail: { status: 'ACTIVE' } },
        recommendedPlanSteps: [{ action: 'resolve dependency before draft' }],
        nextStepsGuidance: 'Use a connected reader to resolve required factual identifiers.',
        primaryToolSlugs: tools.map(row => row._composio.slug),
        relatedToolSlugs: [],
        searchStrategy: input.searchPayload.search_strategy,
      };
    },
    async executeToolsParallel() { return [{ successful: true, data: { ok: true } }]; },
    async createConnectLink() { throw new Error('not expected'); },
  };
}

test('authority uses the leading action rather than nouns in a tool slug', () => {
  assert.equal(capabilityAuthority('LINKEDIN_GET_POST_CONTENT'), 'read');
  assert.equal(capabilityAuthority('GMAIL_SEND_DRAFT'), 'write');
  assert.equal(capabilityAuthority('NOTION_CREATE_PAGE'), 'write');
});

test('synthesis receives successful structured evidence while the durable ledger stays redacted', () => {
  const receipt = {
    slug: 'ANY_PROVIDER_LIST_ITEMS',
    successful: true,
    outcome_ids: ['latest'],
    summary: 'Provider operation completed',
    data: { items: [{ title: 'First returned item', timestamp: '2026-09-05T17:00:00Z' }] },
  };
  assert.deepEqual(synthesisReceipt(receipt), {
    slug: 'ANY_PROVIDER_LIST_ITEMS',
    successful: true,
    outcome_ids: ['latest'],
    summary: 'Provider operation completed',
    error_code: null,
    draft_id: null,
    data: receipt.data,
  });
  assert.equal(synthesisReceipt({ ...receipt, successful: false }).data, null);
});

test('verifier rejects a write selected as a read and premature clarification', () => {
  const state = {
    intent: { outcomes: [{ id: 'one', description: 'look up profile' }] },
    capabilities: [{ slug: 'LINKEDIN_GET_MY_INFO', authority: 'read', description: 'Read authenticated profile', fields: [], schema: { properties: {} } }],
    receipts: [],
    searchQueries: [],
    discoveryAttempts: 0,
  };
  assert.equal(verifyPlanCandidate(state, { action: 'read', tool_slug: 'GMAIL_SEND_DRAFT' }).code, 'tool_not_discovered');
  assert.equal(verifyPlanCandidate(state, { action: 'ask', question: 'Which account?' }).code, 'premature_clarification');
  const draftOnly = { ...state, intent: { outcomes: [{ id: 'draft', kind: 'draft', description: 'send an update' }] } };
  assert.equal(verifyPlanCandidate(draftOnly, { action: 'read', tool_slug: 'LINKEDIN_GET_MY_INFO', outcome_ids: ['draft'] }).code, 'read_cannot_complete_draft');
  assert.deepEqual(missingRequiredFields({ required: ['post_id'], properties: { post_id: { type: 'string' } } }, {}), [{ field: 'post_id', schema: { type: 'string' } }]);
});

test('provider event ledger deduplicates by provider event id, not delivery count', async () => {
  const prisma = fakePrisma();
  const ledger = new GovernedAgentEventLedger({ prisma });
  const first = await ledger.receiveProviderEvent({ orgId: 'org', userId: 'user', runId: 'run', provider: 'gmail', eventId: 'evt-1', eventType: 'message', payload: { id: 'private' } });
  const replay = await ledger.receiveProviderEvent({ orgId: 'org', userId: 'user', runId: 'run', provider: 'gmail', eventId: 'evt-1', eventType: 'message', payload: { id: 'private' } });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(first.event.payload.payload_keys, ['id']);
});

test('a missing provider identifier cannot create an approval draft', async () => {
  const prisma = fakePrisma();
  const calls = [];
  const draftFollowUp = tool('GMAIL_SEND_DRAFT', {
    type: 'object', properties: { draft_id: { type: 'string' } }, required: ['draft_id'], additionalProperties: false,
  });
  const result = await runGovernedAgentRuntime({
    message: 'Send an email to Rama about Singulance.',
    ctx: {
      orgId: 'org', userId: 'user', language: 'en', threadId: 'thread-1', historyTurns: 2,
      governedDecision: async ({ stage, input }) => {
        calls.push({ stage, input });
        if (stage === 'intent') return {
          locale: 'en', kind: 'write', apps: ['gmail'], discovery_query: 'prepare an email draft for a named recipient',
          outcomes: [{ id: 'draft', kind: 'draft', description: 'prepare an email draft' }], known_facts: { recipient_name: 'Rama' },
        };
        if (stage === 'planning') return { action: 'draft', tool_slug: 'GMAIL_SEND_DRAFT', purpose: 'outcome', outcome_ids: ['draft'], reason: 'draft it' };
        if (stage === 'arguments') return {};
        if (stage === 'synthesis') return { response: 'done' };
        throw new Error(`unexpected stage ${stage}`);
      },
    },
    composio: composioWith([draftFollowUp]),
    prisma,
    checkpointer: new MemorySaver(),
  });
  assert.equal(result.status, 'needs_input');
  assert.equal(prisma.drafts.length, 0);
  assert.ok(calls.some(call => call.stage === 'planning' && call.input.composio_recommendation.steps.length === 1));
});

test('a named entity causes one bounded dependency search before a business-language clarification', async () => {
  const prisma = fakePrisma();
  const searches = [];
  const send = tool('GMAIL_SEND_EMAIL', {
    type: 'object', properties: { recipient_email: { type: 'string' }, body: { type: 'string' } },
    required: ['recipient_email', 'body'], additionalProperties: false,
  });
  const composio = composioWith([send]);
  const discover = composio.discoverSessionTools.bind(composio);
  composio.discoverSessionTools = async (orgId, input) => {
    searches.push(input.useCases?.[0]);
    return discover(orgId, input);
  };
  const result = await runGovernedAgentRuntime({
    message: 'Send an email to Rama about Singulance.',
    ctx: {
      orgId: 'org', userId: 'user', language: 'en', threadId: 'thread-named-entity', historyTurns: 2,
      governedDecision: async ({ stage }) => {
        if (stage === 'intent') return {
          locale: 'en', kind: 'write', apps: ['gmail'], discovery_query: 'prepare an email draft for a named recipient',
          outcomes: [{ id: 'draft', kind: 'draft', description: 'prepare an email draft' }], known_facts: { recipient_name: 'Rama' },
        };
        if (stage === 'planning') return { action: 'draft', tool_slug: 'GMAIL_SEND_EMAIL', outcome_ids: ['draft'], reason: 'create a draft when it is grounded' };
        if (stage === 'arguments') return {};
        throw new Error(`unexpected stage ${stage}`);
      },
    },
    composio, prisma, checkpointer: new MemorySaver(),
  });
  assert.equal(result.status, 'needs_input');
  assert.equal(searches.length, 2);
  assert.notEqual(searches[0], searches[1]);
  assert.deepEqual(result.inputRequests[0].fields.map(field => field.name), ['recipient_email', 'body']);
  assert.deepEqual(result.inputRequests[0].fields.map(field => field.label), ['the recipient’s email address', 'what you would like to say']);
  assert.match(result.inputRequests[0].prompt, /recipient’s email address/i);
  assert.equal(prisma.drafts.length, 0);
});

test('a schema-valid, evidence-grounded write becomes a draft and never executes before approval', async () => {
  const prisma = fakePrisma();
  let executeCalls = 0;
  const send = tool('GMAIL_SEND_EMAIL', {
    type: 'object', properties: { recipient_email: { type: 'string' }, body: { type: 'string' } },
    required: ['recipient_email', 'body'], additionalProperties: false,
  });
  const composio = composioWith([send]);
  composio.executeToolsParallel = async () => { executeCalls += 1; return [{ successful: true, data: {} }]; };
  const result = await runGovernedAgentRuntime({
    message: 'Draft an email to rama@example.com saying Singulance is ready. Do not send it.',
    ctx: {
      orgId: 'org', userId: 'user', language: 'en', threadId: 'thread-2', historyTurns: 2,
      governedDecision: async ({ stage }) => {
        if (stage === 'intent') return {
          locale: 'en', kind: 'write', apps: ['gmail'], discovery_query: 'prepare an email draft',
          outcomes: [{ id: 'draft', kind: 'draft', description: 'prepare an email draft' }], known_facts: { recipient_email: 'rama@example.com' },
        };
        if (stage === 'planning') return { action: 'draft', tool_slug: 'GMAIL_SEND_EMAIL', purpose: 'outcome', outcome_ids: ['draft'], reason: 'draft it' };
        if (stage === 'arguments') return { recipient_email: 'rama@example.com', body: 'Singulance is ready.' };
        if (stage === 'synthesis') return { response: 'done' };
        throw new Error(`unexpected stage ${stage}`);
      },
    },
    composio,
    prisma,
    checkpointer: new MemorySaver(),
  });
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.draftIds, ['draft-1']);
  assert.equal(prisma.drafts.length, 1);
  assert.equal(executeCalls, 0);
});

test('Core evidence is a first-class prerequisite and an approved draft executes once before sealing', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  let externalCalls = 0;
  const send = tool('GMAIL_SEND_EMAIL', {
    type: 'object', properties: { recipient_email: { type: 'string' }, body: { type: 'string' } },
    required: ['recipient_email', 'body'], additionalProperties: false,
  });
  const composio = composioWith([send]);
  composio.executeToolsParallel = async () => {
    externalCalls += 1;
    return [{ successful: true, data: { message_id: 'provider-receipt' } }];
  };
  const ctx = {
    orgId: 'org', userId: 'user', language: 'en', threadId: 'thread-core', historyTurns: 2,
    _tracedDispatch: async (name) => {
      assert.equal(name, 'hivemind_recall');
      return { memories: [{ title: 'Singulance', content: 'Governed runtime is ready.' }] };
    },
    governedDecision: async ({ stage, input }) => {
      if (stage === 'intent') return {
        locale: 'en', kind: 'write', apps: ['gmail'], discovery_query: 'prepare a governed email draft about Singulance',
        outcomes: [{ id: 'draft', kind: 'draft', description: 'prepare the email draft' }],
        known_facts: { recipient_email: 'rama@example.com' },
      };
      if (stage === 'planning') {
        return input.receipts.some(row => row.slug === 'hivemind_recall')
          ? { action: 'draft', tool_slug: 'GMAIL_SEND_EMAIL', outcome_ids: ['draft'], reason: 'evidence is available' }
          : { action: 'read', tool_slug: 'hivemind_recall', purpose: 'prerequisite', outcome_ids: [], reason: 'load Core evidence first' };
      }
      if (stage === 'arguments') return input.selected_capability.slug === 'hivemind_recall'
        ? { query: 'Singulance' }
        : { recipient_email: 'rama@example.com', body: 'Singulance is ready.' };
      if (stage === 'synthesis') return { response: 'The approved email was sent.' };
      throw new Error(`unexpected stage ${stage}`);
    },
  };
  const pending = await runGovernedAgentRuntime({
    message: 'Send Rama an email about Singulance.', ctx, composio, prisma, checkpointer,
  });
  assert.equal(pending.status, 'pending');
  assert.equal(prisma.runs.get(pending.run.id)?.status, 'awaiting_approval');
  assert.equal(prisma.bindings.get('org:user:user')?.sessionId, 'trs-user-session');
  assert.equal(externalCalls, 0);
  assert.ok(pending.steps.some(step => step.slug === 'hivemind_recall' && step.status === 'completed'));
  const completed = await runGovernedAgentRuntime({
    message: 'Send Rama an email about Singulance.',
    ctx: { ...ctx, governedGraphThreadId: pending.resumeState.graph_thread_id, governedRunId: pending.run.id },
    choice: { run_id: pending.run.id, action: 'approve', approval_id: pending.draftIds[0] },
    composio, prisma, checkpointer,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(externalCalls, 1);
  assert.equal(prisma.drafts[0].status, 'sent');
  assert.ok([...prisma.events.values()].some(event => event.payload?.state === 'sealed'));
});

test('a nonterminal provider acknowledgement stays pending until a typed provider outcome resumes the same graph', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  const send = tool('GMAIL_SEND_EMAIL', {
    type: 'object', properties: { recipient_email: { type: 'string' }, body: { type: 'string' } },
    required: ['recipient_email', 'body'], additionalProperties: false,
  });
  const composio = composioWith([send]);
  composio.executeToolsParallel = async () => [{ successful: true, data: { asynchronous: true, status: 'queued' } }];
  const ctx = {
    orgId: 'org', userId: 'user', language: 'en', threadId: 'thread-provider', historyTurns: 2,
    governedDecision: async ({ stage }) => {
      if (stage === 'intent') return {
        locale: 'en', kind: 'write', apps: ['gmail'], discovery_query: 'prepare an email draft',
        outcomes: [{ id: 'draft', kind: 'draft', description: 'prepare the email draft' }],
        known_facts: { recipient_email: 'rama@example.com' },
      };
      if (stage === 'planning') return { action: 'draft', tool_slug: 'GMAIL_SEND_EMAIL', outcome_ids: ['draft'], reason: 'draft it' };
      if (stage === 'arguments') return { recipient_email: 'rama@example.com', body: 'Singulance is ready.' };
      if (stage === 'synthesis') return { response: 'The provider confirmed the action.' };
      throw new Error(`unexpected stage ${stage}`);
    },
  };
  const pending = await runGovernedAgentRuntime({ message: 'Draft an email.', ctx, composio, prisma, checkpointer });
  const waiting = await runGovernedAgentRuntime({
    message: 'Draft an email.',
    ctx: { ...ctx, governedGraphThreadId: pending.resumeState.graph_thread_id, governedRunId: pending.run.id },
    choice: { run_id: pending.run.id, action: 'approve', approval_id: pending.draftIds[0] },
    composio, prisma, checkpointer,
  });
  assert.equal(waiting.status, 'pending');
  assert.equal(waiting.run.status, 'awaiting_provider_event');
  assert.equal(prisma.drafts[0].status, 'approved');
  const completed = await runGovernedAgentRuntime({
    message: 'Draft an email.',
    ctx: { ...ctx, governedGraphThreadId: waiting.resumeState.graph_thread_id, governedRunId: pending.run.id },
    choice: { run_id: pending.run.id, outcome: 'succeeded', event_id: 'provider-event-1' },
    composio, prisma, checkpointer,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(prisma.drafts[0].status, 'sent');
});

test('provider-event ingress deduplicates replay before it can resume a settled write again', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  let executions = 0;
  const send = tool('GMAIL_SEND_EMAIL', {
    type: 'object', properties: { recipient_email: { type: 'string' }, body: { type: 'string' } },
    required: ['recipient_email', 'body'], additionalProperties: false,
  });
  const composio = composioWith([send]);
  composio.executeToolsParallel = async () => {
    executions += 1;
    return [{ successful: true, data: { asynchronous: true, status: 'queued' } }];
  };
  const ctx = {
    orgId: 'org', userId: 'user', language: 'en', threadId: 'thread-provider-ingress', historyTurns: 2,
    governedDecision: async ({ stage }) => {
      if (stage === 'intent') return {
        locale: 'en', kind: 'write', apps: ['gmail'], discovery_query: 'prepare an email draft',
        outcomes: [{ id: 'draft', kind: 'draft', description: 'prepare the email draft' }], known_facts: { recipient_email: 'rama@example.com' },
      };
      if (stage === 'planning') return { action: 'draft', tool_slug: 'GMAIL_SEND_EMAIL', outcome_ids: ['draft'], reason: 'draft it' };
      if (stage === 'arguments') return { recipient_email: 'rama@example.com', body: 'Singulance is ready.' };
      if (stage === 'synthesis') return { response: 'The provider confirmed the action.' };
      throw new Error(`unexpected stage ${stage}`);
    },
  };
  const pending = await runGovernedAgentRuntime({ message: 'Draft an email.', ctx, composio, prisma, checkpointer });
  const waiting = await runGovernedAgentRuntime({
    message: 'Draft an email.',
    ctx: { ...ctx, governedGraphThreadId: pending.resumeState.graph_thread_id, governedRunId: pending.run.id },
    choice: { run_id: pending.run.id, action: 'approve', approval_id: pending.draftIds[0] },
    composio, prisma, checkpointer,
  });
  assert.equal(waiting.run.status, 'awaiting_provider_event');
  const delivered = await resumeGovernedProviderEvent({
    ctx, prisma, checkpointer, runId: pending.run.id, provider: 'gmail', eventId: 'evt-provider-1', eventType: 'delivery', outcome: 'succeeded',
  });
  const replay = await resumeGovernedProviderEvent({
    ctx, prisma, checkpointer, runId: pending.run.id, provider: 'gmail', eventId: 'evt-provider-1', eventType: 'delivery', outcome: 'succeeded',
  });
  assert.equal(delivered.status, 'completed');
  assert.equal(replay.status, 'duplicate');
  assert.equal(executions, 1);
  assert.equal(prisma.drafts[0].status, 'sent');
});

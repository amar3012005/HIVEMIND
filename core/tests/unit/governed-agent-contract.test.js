import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import { projectGovernedEvidence } from '../../src/agent/governed-evidence-projection.js';
import {
  capabilityAuthority,
  invalidSchemaValues,
  missingRequiredFields,
  renderStructuredReceiptEvidence,
  receiptSatisfiesEvidence,
  synthesisReceipt,
  validSynthesisResponse,
  verifyPlanCandidate,
} from '../../src/agent/governed-agent-contract.js';
import { GovernedAgentEventLedger } from '../../src/agent/governed-agent-event-ledger.js';
import { resumeGovernedProviderEvent, runGovernedAgentRuntime } from '../../src/agent/governed-agent-runtime.js';

function fakePrisma() {
  const runs = new Map();
  const drafts = [];
  const events = new Map();
  const bindings = new Map();
  const durableTurns = [];
  const bindingKey = ({ orgId, userId, connectionScope }) => `${orgId}:${userId}:${connectionScope}`;
  return {
    runs,
    drafts,
    events,
    bindings,
    durableTurns,
    agentRun: {
      async create({ data }) { runs.set(data.id, { ...data }); return runs.get(data.id); },
      async update({ where, data }) { const row = { ...(runs.get(where.id) || {}), ...data, id: where.id }; runs.set(where.id, row); return row; },
      async findFirst({ where }) { return [...runs.values()].find(row => Object.entries(where).every(([key, value]) => row[key] === value)) || null; },
      async findMany({ where }) {
        return [...runs.values()].filter(row => row.orgId === where.orgId && row.userId === where.userId && where.id.in.includes(row.id));
      },
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
    durableChatTurn: {
      async findMany({ where, take }) {
        return durableTurns.filter(row => row.orgId === where.orgId && row.userId === where.userId &&
          row.threadDigest === where.threadDigest && row.status === where.status).slice(0, take);
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

test('schema descriptions cannot admit a plain name as an email destination', () => {
  const schema = { type: 'object', properties: { recipient_email: {
    type: 'string', description: 'Primary recipient email address. Must be a full user@domain address.',
  } } };
  assert.equal(invalidSchemaValues(schema, { recipient_email: 'rama' })[0].code, 'invalid_email_address');
  assert.deepEqual(invalidSchemaValues(schema, { recipient_email: 'Rama <rama@example.com>' }), []);
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
    evidence_sufficient: true,
    evidence_checks: [],
    data: receipt.data,
  });
  assert.equal(synthesisReceipt({ ...receipt, successful: false }).data, null);
});

test('structured receipt fallback renders records and rejects object coercion', () => {
  const rendered = renderStructuredReceiptEvidence([{
    slug: 'ANY_PROVIDER_LIST_ITEMS', successful: true,
    data: { items: [{ subject: 'First', sender: 'Ada', received_at: '2026-09-05T17:00:00Z' }] },
  }]);
  assert.match(rendered, /\| subject \| sender \| received_at \|/);
  assert.match(rendered, /\| First \| Ada \| 2026-09-05T17:00:00Z \|/);
  assert.equal(validSynthesisResponse([{ subject: 'First' }]), null);
  assert.equal(validSynthesisResponse('[object Object]'), null);
  assert.equal(validSynthesisResponse('First returned item'), 'First returned item');
});

test('provider success does not satisfy an unmet generic evidence contract', () => {
  const requirement = { min_records: 5, required_fields: ['subject', 'sender', 'time'] };
  const threadReceipt = { threads: Array.from({ length: 5 }, (_, index) => ({ id: String(index), title: `Thread ${index}` })) };
  const emailReceipt = { records: Array.from({ length: 5 }, (_, index) => ({
    subject: `Subject ${index}`, from: `sender-${index}`, messageTimestamp: `2026-09-05T10:0${index}:00Z`,
  })) };
  assert.deepEqual(receiptSatisfiesEvidence(threadReceipt, requirement), {
    ok: false, code: 'required_evidence_fields_missing', missing_fields: ['sender', 'time'], observed_records: 5, required_records: 5,
  });
  assert.deepEqual(receiptSatisfiesEvidence(emailReceipt, requirement), {
    ok: true, code: 'evidence_contract_satisfied', observed_records: 5, required_records: 5,
  });
  assert.equal(receiptSatisfiesEvidence({ records: emailReceipt.records.slice(0, 2) }, requirement).code, 'insufficient_record_count');
  assert.equal(receiptSatisfiesEvidence({
    sender: 'Provider', subject: 'Alert', messageText: 'Details', messageTimestamp: '2026-09-05T10:00:00Z',
    payload: { headers: Array.from({ length: 24 }, (_, index) => ({ name: `Header-${index}`, value: 'x' })) },
  }, { min_records: 1, required_fields: ['sender', 'subject', 'messagetext', 'messagetimestamp'] }).ok, true);
});

test('five large records survive executor and model projections with Markdown intact', () => {
  const records = Array.from({ length: 5 }, (_, index) => ({
    body: 'Long newsletter content '.repeat(6000),
    subject: `Unique subject ${index}`, sender: `sender-${index}@example.com`,
    time: `2026-09-05T10:0${index}:00Z`,
  }));
  const execution = projectGovernedEvidence({ records }, 24000);
  const modelInput = projectGovernedEvidence({ receipts: [{ successful: true, data: execution }] });
  assert.equal(modelInput.receipts[0].data.records.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.equal(modelInput.receipts[0].data.records[i].subject, records[i].subject);
    assert.equal(modelInput.receipts[0].data.records[i].sender, records[i].sender);
    assert.equal(modelInput.receipts[0].data.records[i].time, records[i].time);
  }
  const markdown = '| Subject | Sender |\n| --- | --- |\n| Test | Ada |';
  assert.equal(validSynthesisResponse(markdown), markdown);
});

test('graph recovers missing detail evidence before returning all five records', async () => {
  const prisma = fakePrisma();
  const list = tool('APP_LIST_ITEMS', { type: 'object', properties: {} });
  const detail = tool('APP_FETCH_ITEMS', { type: 'object', properties: {} });
  const composio = composioWith([list, detail]);
  const calls = [];
  const records = Array.from({ length: 5 }, (_, i) => ({ subject: `Subject ${i}`, sender: `author${i}`, time: `10:0${i}`, body: 'x'.repeat(20000) }));
  composio.executeToolsParallel = async (_org, tools) => {
    calls.push(tools[0].slug);
    return [{ successful: true, data: { records: tools[0].slug === 'APP_LIST_ITEMS' ? records.map((_, i) => ({ id: `${i}` })) : records } }];
  };
  const result = await runGovernedAgentRuntime({
    message: 'Show the latest five records with subject, sender, and time.',
    ctx: { orgId: 'org', userId: 'user', governedDecision: async ({ stage, input }) => {
      if (stage === 'intent') return { locale: 'en', apps: ['gmail'], discovery_query: 'retrieve five latest records with subject sender time', outcomes: [{ id: 'read', kind: 'read', description: 'five records and fields' }] };
      if (stage === 'planning') return { action: 'read', tool_slug: input.receipts.length ? 'APP_FETCH_ITEMS' : 'APP_LIST_ITEMS', purpose: 'outcome', outcome_ids: ['read'] };
      if (stage === 'arguments') return {};
      if (stage === 'synthesis') {
        const data = input.receipts.at(-1).data.records;
        if (!data[0].subject) return { complete: false, response: 'More detail required.', missing_outcomes: ['read'], recovery_instruction: 'Fetch the details for these IDs.' };
        assert.equal(data.length, 5);
        assert.equal(data[4].sender, 'author4');
        return { complete: true, response: '| Subject | Sender | Time |\n| --- | --- | --- |\n' + data.map(r => `| ${r.subject} | ${r.sender} | ${r.time} |`).join('\n') };
      }
      throw new Error(`Unexpected stage ${stage}`);
    } }, prisma, composio, checkpointer: new MemorySaver(),
  });
  assert.deepEqual(calls, ['APP_LIST_ITEMS', 'APP_FETCH_ITEMS']);
  assert.equal(result.status, 'completed');
  assert.equal(result.response.split('\n').length, 7);
  assert.match(result.response, /Subject 4/);
});

test('a new graph run resolves a follow-up from tenant-scoped prior receipt evidence', async () => {
  const prisma = fakePrisma();
  const threadId = 'durable-follow-up-thread';
  const priorRunId = '00000000-0000-4000-8000-000000000099';
  prisma.runs.set(priorRunId, {
    id: priorRunId, orgId: 'org', userId: 'user',
    scratch: { receipts: [{ slug: 'APP_LIST_ITEMS', successful: true, data: { items: [{ id: 'item-1', subject: 'Security alert', sender: 'Provider' }] } }] },
  });
  prisma.durableTurns.push({
    orgId: 'org', userId: 'user', status: 'completed',
    threadDigest: createHash('sha256').update(threadId).digest('hex'),
    completedAt: new Date(), responsePayload: { execution: { run_id: priorRunId }, response: 'Prior list' }, requestPayload: { message: 'List items' },
  });
  const detail = tool('APP_FETCH_ITEM', {
    type: 'object', properties: { item_id: { type: 'string' } }, required: ['item_id'], additionalProperties: false,
  });
  const composio = composioWith([detail]);
  let executedArgs;
  composio.executeToolsParallel = async (_org, calls) => {
    executedArgs = calls[0].arguments;
    return [{ successful: true, data: { subject: 'Security alert', details: 'A new sign-in was detected.' } }];
  };
  let observedReference;
  const result = await runGovernedAgentRuntime({
    message: 'Tell me more about the Security alert email.',
    ctx: { orgId: 'org', userId: 'user', threadId, historyTurns: 4, governedDecision: async ({ stage, input }) => {
      if (stage === 'intent') {
        assert.equal(input.resolved_reference.record.id, 'item-1');
        return { locale: 'en', kind: 'read', apps: ['gmail'], discovery_query: 'fetch full details for the referenced prior item', outcomes: [{ id: 'detail', kind: 'read', description: 'details of the referenced item' }] };
      }
      if (stage === 'planning') {
        observedReference = input.prior_conversation_evidence;
        return { action: 'read', tool_slug: 'APP_FETCH_ITEM', outcome_ids: ['detail'] };
      }
      if (stage === 'arguments') return { item_id: input.resolved_reference.record.id };
      if (stage === 'synthesis') return { complete: true, response: 'A new sign-in was detected.' };
      throw new Error(`Unexpected stage ${stage}`);
    } },
    composio, prisma, checkpointer: new MemorySaver(),
  });
  assert.equal(observedReference[0].data.items[0].subject, 'Security alert');
  assert.deepEqual(executedArgs, { item_id: 'item-1' });
  assert.equal(result.status, 'completed');
  assert.match(result.response, /new sign-in/i);
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
  const recoverable = {
    ...state,
    discoveryAttempts: 2,
    capabilities: [...state.capabilities, { slug: 'APP_FETCH_ITEMS', authority: 'read', description: 'Fetch complete items', fields: [], schema: { properties: {} } }],
    receipts: [{ slug: 'LINKEDIN_GET_MY_INFO', successful: true, evidence_sufficient: false }],
  };
  assert.equal(verifyPlanCandidate(recoverable, { action: 'ask', question: 'What information?' }).code,
    'premature_clarification_after_insufficient_evidence');
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

test('a canonical Core mutation is exposed but executes only after approval', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  let writes = 0;
  const ctx = {
    orgId: 'org', userId: 'user', language: 'en', threadId: 'thread-core-write', historyTurns: 2,
    _tracedDispatch: async (name, args) => {
      assert.equal(name, 'hivemind_save_memory');
      assert.equal(args.title, 'Governed agent rollout');
      assert.equal(args.content, 'The governed agent exposes canonical Core tools behind approval.');
      assert.equal(args.memory_type, 'fact');
      assert.equal(args.scope, 'personal');
      writes += 1;
      return { saved: true, memory_id: 'memory-1' };
    },
    governedDecision: async ({ stage }) => {
      if (stage === 'intent') return {
        locale: 'en', kind: 'write', apps: ['HIVE-MIND'], discovery_query: 'save one durable memory',
        outcomes: [{ id: 'save_memory', kind: 'draft', description: 'save the supplied durable memory' }],
        known_facts: {
          title: 'Governed agent rollout',
          content: 'The governed agent exposes canonical Core tools behind approval.',
          tags: ['governed-agent', 'runtime'],
        },
        entities: [], business_question: null, reference_selector: null,
      };
      if (stage === 'planning') return {
        action: 'draft', tool_slug: 'hivemind_save_memory', outcome_ids: ['save_memory'], reason: 'canonical Core mutation',
      };
      if (stage === 'arguments') return {
        title: 'Governed agent rollout',
        content: 'The governed agent exposes canonical Core tools behind approval.',
        tags: ['governed-agent', 'runtime'],
      };
      if (stage === 'synthesis') return { response: 'The approved memory was saved.' };
      throw new Error(`unexpected stage ${stage}`);
    },
  };
  const composio = composioWith([]);
  const pending = await runGovernedAgentRuntime({ message: 'Remember this personal fact.', ctx, composio, prisma, checkpointer });
  assert.equal(pending.status, 'pending');
  assert.equal(writes, 0);
  assert.equal(prisma.drafts[0].provider, 'hivemind');
  const completed = await runGovernedAgentRuntime({
    message: 'Remember this personal fact.',
    ctx: { ...ctx, governedGraphThreadId: pending.resumeState.graph_thread_id, governedRunId: pending.run.id },
    choice: { run_id: pending.run.id, action: 'approve', approval_id: pending.draftIds[0] },
    composio, prisma, checkpointer,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(writes, 1);
  assert.equal(prisma.drafts[0].status, 'sent');
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

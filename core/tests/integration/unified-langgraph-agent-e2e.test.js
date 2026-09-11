import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySaver } from '@langchain/langgraph';

import { runUnifiedMetaAgent, UNIFIED_META_HARNESS_VERSION } from '../../src/agent/unified-langgraph-agent.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';

function call(name, args, id) {
  return { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

function fakePrisma() {
  const drafts = [];
  return {
    drafts,
    pendingWrite: {
      async findFirst({ where }) {
        return drafts.find(row => (where.id ? row.id === where.id : row.idempotencyKey === where.idempotencyKey)
          && (!where.orgId || row.orgId === where.orgId) && (!where.userId || row.userId === where.userId)) || null;
      },
      async create({ data }) { const row = { id: `draft-${drafts.length + 1}`, ...data }; drafts.push(row); return row; },
      async updateMany({ where, data }) {
        const rows = drafts.filter(row => Object.entries(where).every(([key, value]) => {
          if (key === 'expiresAt') return row.expiresAt > value.gt;
          return row[key] === value;
        }));
        rows.forEach(row => Object.assign(row, data)); return { count: rows.length };
      },
      async update({ where, data }) { const row = drafts.find(item => item.id === where.id); Object.assign(row, data); return row; },
    },
  };
}

function ctx(prisma, suffix, language = 'en') {
  return { orgId: ORG, userId: USER, prisma, language, threadId: `thread-${suffix}`, unifiedGraphThreadId: `unified-${suffix}`, model: 'test' };
}

test('one model-tool graph handles native recall and final synthesis with only hivemind_meta', async () => {
  const prisma = fakePrisma();
  const seenTools = [];
  let turn = 0;
  const modelStep = async ({ tools }) => {
    seenTools.push(tools.map(row => row.function.name));
    turn += 1;
    if (turn === 1) return { message: call('hivemind_meta', { operation: 'recall', recall: { query: 'Was wissen wir über Rama?', mode: 'fact', limit: 5 } }, 'm1') };
    return { message: { role: 'assistant', content: 'Wir wissen aus den gespeicherten Quellen, dass Rama am Singulance-Projekt beteiligt ist.' } };
  };
  const result = await runUnifiedMetaAgent({
    message: 'Was wissen wir über Rama?', useTools: false, prisma, ctx: ctx(prisma, 'native', 'de'), checkpointer: new MemorySaver(), modelStep,
    metaExecutor: async () => ({ successful: true, data: { memories: [{ title: 'Rama and Singulance', content: 'Rama is involved in the Singulance project.' }] } }),
    composio: {},
  });
  assert.equal(result.status, 'completed');
  assert.match(result.response, /Rama/);
  assert.deepEqual(seenTools, [['hivemind_meta'], ['hivemind_meta']]);
  assert.equal(result.run.scratch.harness_version, UNIFIED_META_HARNESS_VERSION);
});

test('the same graph progressively searches, loads one selected schema, executes, and renders provider records', async () => {
  const prisma = fakePrisma();
  const events = [];
  const calls = [];
  let turn = 0;
  const modelStep = async ({ tools }) => {
    assert.deepEqual(tools.map(row => row.function.name), ['hivemind_meta', 'hivemind_connected_task']);
    turn += 1;
    if (turn === 1) return { message: call('hivemind_connected_task', { action: 'search', queries: [{ use_case: 'Fetch the five newest unread Gmail emails with subject sender and received timestamp' }], session: { generate_id: true }, toolkits: ['gmail'] }, 'c1') };
    if (turn === 2) return { message: call('hivemind_connected_task', { action: 'schemas', tool_slugs: ['GMAIL_FETCH_EMAILS'] }, 'c2') };
    if (turn === 3) return { message: call('hivemind_connected_task', { action: 'execute', tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { query: 'is:unread', max_results: 5 } }, 'c3') };
    return { message: { role: 'assistant', content: '| Subject | Sender | Time |\n|---|---|---|\n| Security alert | Google | 17:08 |\n| Build passed | GitHub | 16:30 |' } };
  };
  const composio = {
    async discoverSessionTools(_org, input) {
      calls.push(['search', input.hydrateSchemas, input.searchPayload.queries]);
      return { sessionId: 'session-1', workflowSessionId: 'workflow-1', primaryToolSlugs: ['GMAIL_FETCH_EMAILS'], relatedToolSlugs: [], toolkitConnectionStatuses: { gmail: 'connected' }, recommendedPlanSteps: ['Fetch emails'] };
    },
    async getSessionToolSchemas(sessionId, slugs) {
      calls.push(['schemas', sessionId, slugs]);
      return { GMAIL_FETCH_EMAILS: { read_only: true, input_schema: { type: 'object', additionalProperties: false, required: ['query', 'max_results'], properties: { query: { type: 'string' }, max_results: { type: 'integer' } } } } };
    },
    async executeToolsParallel(_org, input, options) {
      calls.push(['execute', input, options]);
      return [{ successful: true, data: { messages: [{ subject: 'Security alert', sender: 'Google', time: '17:08' }, { subject: 'Build passed', sender: 'GitHub', time: '16:30' }] } }];
    },
  };
  const result = await runUnifiedMetaAgent({ message: 'What are my five latest unread emails?', useTools: true, prisma, ctx: ctx(prisma, 'read'), checkpointer: new MemorySaver(), modelStep, composio, onEvent: event => events.push(event) });
  assert.equal(result.status, 'completed');
  assert.match(result.response, /\| Subject \| Sender \| Time \|/);
  assert.match(result.response, /\n\|[-: ]+\|[-: ]+\|[-: ]+\|/);
  assert.deepEqual(calls[0].slice(0, 2), ['search', false]);
  assert.deepEqual(calls[1], ['schemas', 'session-1', ['GMAIL_FETCH_EMAILS']]);
  assert.equal(calls.filter(row => row[0] === 'execute').length, 1);
  assert.ok(events.some(event => event.type === 'tool_result' && event.name === 'GMAIL_FETCH_EMAILS'));
});

test('a connected write becomes a durable approval and executes exactly once after resume', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  let executions = 0;
  let turn = 0;
  const modelStep = async () => {
    turn += 1;
    if (turn === 1) return { message: call('hivemind_connected_task', { action: 'search', queries: [{ use_case: 'Send one Gmail email after human approval' }], session: { generate_id: true }, toolkits: ['gmail'] }, 'w1') };
    if (turn === 2) return { message: call('hivemind_connected_task', { action: 'schemas', tool_slugs: ['GMAIL_SEND_EMAIL'] }, 'w2') };
    if (turn === 3) return { message: call('hivemind_connected_task', { action: 'execute', tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'rama@example.test', subject: 'Singulance', body: 'A concise update.' } }, 'w3') };
    return { message: { role: 'assistant', content: 'The approved email was sent once.' } };
  };
  const composio = {
    async discoverSessionTools() { return { sessionId: 'session-write', primaryToolSlugs: ['GMAIL_SEND_EMAIL'], relatedToolSlugs: [], toolkitConnectionStatuses: { gmail: 'connected' } }; },
    async getSessionToolSchemas() { return { GMAIL_SEND_EMAIL: { is_write: true, input_schema: { type: 'object', additionalProperties: false, required: ['recipient_email', 'subject', 'body'], properties: { recipient_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } } } } }; },
    async executeToolsParallel() { executions += 1; return [{ successful: true, data: { message_id: 'sent-1' } }]; },
  };
  const runtimeCtx = ctx(prisma, 'write');
  const first = await runUnifiedMetaAgent({ message: 'Send Rama an email about Singulance', useTools: true, prisma, ctx: runtimeCtx, checkpointer, modelStep, composio });
  assert.equal(first.status, 'pending');
  assert.equal(prisma.drafts[0].status, 'draft');
  assert.equal(executions, 0);
  const completed = await runUnifiedMetaAgent({ message: 'Send Rama an email about Singulance', useTools: true, prisma, ctx: { ...runtimeCtx, unifiedRunId: first.run.id }, checkpointer, modelStep, composio, choice: { action: 'approve', run_id: first.run.id } });
  assert.equal(completed.status, 'completed');
  assert.equal(prisma.drafts[0].status, 'sent');
  assert.equal(executions, 1);
});

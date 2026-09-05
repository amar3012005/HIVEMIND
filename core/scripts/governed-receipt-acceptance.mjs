// Run inside the authorized Core environment; prints only structural evidence.
// No credential creation, external mutations, or approval execution.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

const root = process.env.GOVERNED_ACCEPTANCE_CORE_ROOT || process.cwd();
const { internalFetch } = await import(pathToFileURL(`${root}/src/internal/internal-fetch.js`));
const email = process.env.GOVERNED_ACCEPTANCE_EMAIL;
const stream = process.env.GOVERNED_ACCEPTANCE_STREAM === 'true';
const followup = process.env.GOVERNED_ACCEPTANCE_FOLLOWUP === 'true';
assert.ok(email, 'GOVERNED_ACCEPTANCE_EMAIL is required');
const p = new PrismaClient();
const saver = PostgresSaver.fromConnString(process.env.DATABASE_URL, { schema: 'hivemind_governed_agent_langgraph' });
const normalize = value => String(value || '').replace(/\\/g, '').replace(/\s+/g, ' ').toLowerCase();
try {
  const user = await p.user.findFirst({ where: { email }, select: { id: true } });
  assert.ok(user, 'canary_user_missing');
  const prior = await p.agentRun.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, select: { orgId: true } });
  assert.ok(prior, 'canary_scope_missing');
  const started = Date.now();
  const threadId = `receipt-acceptance-${crypto.randomUUID()}`;
  const response = await internalFetch('http://core:3000/api/chat', {
    method: 'POST', userId: user.id, orgId: prior.orgId,
    body: {
      message: 'What are my 5 latest unread Gmail emails? Show subject, sender, and time in UTC. Then briefly summarize what they are about.',
      use_tools: true, history_turns: followup ? 4 : 0, thread_id: threadId,
      stream,
    },
  });
  assert.equal(response.status, 200, 'chat_endpoint_failed');
  let result;
  if (stream) {
    const events = (await response.text()).split('\n')
      .filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    result = events.findLast(event => event.type === 'done');
    assert.ok(result, 'SSE_done_event_missing');
    const transitions = events.filter(event => event.type === 'state_transition');
    assert.ok(transitions.length, 'SSE_governed_transitions_missing');
    assert.ok(transitions.every(event => event.run_id === result.execution.run_id && event.event_id), 'SSE_event_scope_missing');
    assert.ok(transitions.every((event, i) => !i || event.sequence > transitions[i - 1].sequence), 'SSE_event_order_invalid');
  } else result = await response.json();
  assert.equal(result.harness_version, 'langgraph-native-v1');
  assert.equal(result.compound_status, 'completed');
  assert.equal(result.draft_ids?.length || 0, 0);
  assert.equal(result.pending_actions?.length || 0, 0);
  const run = await p.agentRun.findUnique({ where: { id: result.execution.run_id } });
  assert.equal(run.userId, user.id);
  assert.equal(run.orgId, prior.orgId);
  const checkpoint = await saver.getTuple({ configurable: { thread_id: run.scratch.graph_thread_id } });
  const receipts = checkpoint.checkpoint.channel_values.receipts;
  const records = receipts.flatMap(row => row.successful ? row.data?.messages || [] : []);
  assert.equal(records.length, 5, 'five_receipt_records_required');
  const answer = normalize(result.response);
  const tableRows = result.response.split('\n').filter(row => row.trim().startsWith('|'));
  assert.equal(tableRows.length - 2, 5, 'five_table_rows_required');
  assert.equal(answer.includes('[object object]'), false);
  for (const record of records) {
    assert.ok(answer.includes(normalize(record.subject)), 'subject_missing_or_abbreviated');
    const address = record.sender.match(/<([^>]+)>/)?.[1] || record.sender;
    assert.ok(answer.includes(normalize(address)), 'sender_address_missing_or_abbreviated');
    assert.ok(answer.includes(new Date(record.messageTimestamp).toISOString().slice(11, 16)), 'UTC_time_missing');
  }
  let followupProof = null;
  if (followup) {
    const selected = records[0];
    const detailResponse = await internalFetch('http://core:3000/api/chat', {
      method: 'POST', userId: user.id, orgId: prior.orgId,
      body: {
        message: `Tell me more about this email: ${selected.subject}, from ${selected.sender}, at ${selected.messageTimestamp}`,
        use_tools: true, history_turns: 4, thread_id: threadId,
      },
    });
    assert.equal(detailResponse.status, 200, 'followup_chat_endpoint_failed');
    const detail = await detailResponse.json();
    assert.equal(detail.compound_status, 'completed');
    assert.equal(detail.draft_ids?.length || 0, 0);
    const detailRun = await p.agentRun.findUnique({ where: { id: detail.execution.run_id } });
    assert.equal(detailRun.orgId, prior.orgId);
    assert.equal(detailRun.userId, user.id);
    assert.ok(detailRun.steps.some(step => /MESSAGE_BY_MESSAGE_ID/.test(step.slug || '')), 'detail_capability_not_used');
    assert.ok(JSON.stringify(detailRun.scratch.receipts || []).includes(selected.messageId), 'detail_receipt_does_not_match_reference');
    assert.ok(String(detail.response || '').length > 100, 'followup_detail_response_too_short');
    assert.doesNotMatch(String(detail.response), /couldn.t find|no emails matching/i, 'contradictory_empty_followup');
    followupProof = { run_id: detailRun.id, detail_capability: true, matched_reference: true };
  }
  console.log(JSON.stringify({ passed: true, transport: stream ? 'authenticated_core_chat_SSE' : 'authenticated_core_chat', run_id: run.id,
    receipt_records: records.length, rendered_rows: tableRows.length - 2, checked_fields: ['subject', 'sender', 'UTC time'], followup: followupProof, elapsed_ms: Date.now() - started }));
} finally {
  await saver.end();
  await p.$disconnect();
}

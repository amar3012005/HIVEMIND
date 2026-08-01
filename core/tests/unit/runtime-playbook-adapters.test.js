import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailRuntimeAdapter } from '../../src/runtime-playbooks/adapters/gmail.js';
import { createTenantRecordsAdapter } from '../../src/runtime-playbooks/adapters/tenant-records.js';
import { runtimePlaybookReplyWake } from '../../src/connectors/providers/gmail/gmail-watcher-service.js';

function context() {
  return { orgId: '11111111-1111-4111-8111-111111111111', runId: 'run-1', stageId: 'deliver', roomId: '22222222-2222-4222-8222-222222222222' };
}

test('tenant records verifier rejects prose references and accepts only tenant-owned durable rows', async () => {
  const calls = [];
  const adapter = createTenantRecordsAdapter({ prisma: {
    memory: { async findMany(query) {
      calls.push(query);
      return query.where.id.in.includes('33333333-3333-4333-8333-333333333333')
        ? [{ id: '33333333-3333-4333-8333-333333333333' }]
        : [];
    } },
    sourceArtifact: { async findMany(query) {
      return query.where.id.in.includes('55555555-5555-4555-8555-555555555555')
        ? [{ id: '55555555-5555-4555-8555-555555555555' }]
        : [];
    } },
  } });
  const passed = await adapter.verify({ artifacts: [{ data: { persistence_ref: '33333333-3333-4333-8333-333333333333' } }] }, context());
  assert.equal(passed.passed, true);
  assert.equal(calls[0].where.orgId, context().orgId);
  const failed = await adapter.verify({ artifacts: [{ data: { persistence_ref: 'invented-record' } }] }, context());
  assert.equal(failed.passed, false);
  assert.match(failed.unmet[0].reason, /record_not_found/);
  const response = await adapter.verify({
    artifacts: [{ data: {
      timeline_ref: '33333333-3333-4333-8333-333333333333',
      provider_event_ref: '55555555-5555-4555-8555-555555555555',
    } }],
    config: { record_paths: ['data.timeline_ref'], source_artifact_paths: ['data.provider_event_ref'] },
  }, context());
  assert.equal(response.passed, true);
});

test('Gmail adapter verifies drafts, sends once, records runtime correlation, and reuses the ledger', async () => {
  const sends = [];
  const inserts = [];
  let existing = [];
  const prisma = {
    hyperRoom: { async findFirst() { return { userId: '44444444-4444-4444-8444-444444444444' }; } },
    async $queryRawUnsafe() { return existing; },
    async $executeRawUnsafe(_sql, ...args) {
      inserts.push(args);
      existing = [{ message_id: 'message-1', thread_id: 'thread-1' }];
      return 1;
    },
  };
  const runTool = async (tool, args) => {
    if (tool === 'gmail_get_draft' && sends.length === 0) return { draftId: 'draft-1', to: 'lead@example.test', subject: 'Hello' };
    if (tool === 'gmail_get_draft') throw new Error('draft_not_found');
    if (tool === 'gmail_send_draft') {
      sends.push(args.draftId);
      return { id: 'message-1', threadId: 'thread-1', sent: true };
    }
    throw new Error(`unexpected:${tool}`);
  };
  const adapter = createGmailRuntimeAdapter({ prisma, runTool });
  const draft = { id: 'artifact-draft-1', key: 'draft_record', data: { draft_ref: 'draft-1', lead_ref: 'lead-1' } };
  assert.equal((await adapter.verify({ artifacts: [draft] }, context())).passed, true);
  const first = await adapter.execute({ inputs: { 'artifacts.draft_record': [draft] } }, context());
  const second = await adapter.execute({ inputs: { 'artifacts.draft_record': [draft] } }, context());
  assert.deepEqual(sends, ['draft-1']);
  assert.equal(inserts.length, 1);
  assert.equal(JSON.parse(inserts[0].at(-1)).runtime_playbook_run_id, 'run-1');
  assert.equal(first.artifacts[0].data.correlation_ref, 'thread-1');
  assert.equal(second.artifacts[0].data.provider_receipt_id, 'message-1');
  const monitored = await adapter.monitor({ inputs: { 'artifacts.delivery_receipt': first.artifacts } }, context());
  assert.equal(monitored.artifacts[0].data.subscription_ref, 'gmail-thread:thread-1');
});

test('Gmail adapter marks provider write timeouts ambiguous so the executor cannot replay them', async () => {
  const adapter = createGmailRuntimeAdapter({
    prisma: {
      hyperRoom: { async findFirst() { return { userId: '44444444-4444-4444-8444-444444444444' }; } },
      async $queryRawUnsafe() { return []; },
    },
    runTool: async (tool) => {
      if (tool === 'gmail_get_draft') return { draftId: 'draft-1', to: 'lead@example.test', subject: 'Hello' };
      throw new Error('provider_timeout');
    },
  });
  await assert.rejects(
    () => adapter.execute({ inputs: { 'artifacts.draft_record': [{ data: { draft_ref: 'draft-1' } }] } }, context()),
    (error) => error.ambiguous === true && /runtime_gmail_send_ambiguous/.test(error.message),
  );
});

test('reply watcher produces one exact generic playbook event correlation', () => {
  const wake = runtimePlaybookReplyWake({
    runtime: { id: 'runtime-1', orgId: 'org-1', epoch: 7 },
    artifact: { id: 'artifact-1' },
    payload: {
      runtime_playbook_run_id: 'run-1', provider_event_id: 'gmail:reply-1',
      runtime_correlation_ref: 'thread-1', thread_id: 'thread-1', message_id: 'reply-1', sender: 'lead@example.test',
    },
  });
  assert.equal(wake.triggerType, 'runtime_playbook_event');
  assert.equal(wake.payload.run_id, 'run-1');
  assert.deepEqual(wake.payload.event, {
    id: 'gmail:reply-1', type: 'response.received',
    data: { correlation_ref: 'thread-1', artifact_id: 'artifact-1', message_id: 'reply-1', thread_id: 'thread-1', sender: 'lead@example.test' },
  });
});

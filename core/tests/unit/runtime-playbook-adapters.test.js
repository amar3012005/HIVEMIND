import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailRuntimeAdapter } from '../../src/runtime-playbooks/adapters/gmail.js';
import { createTaraOutreachRuntimeAdapter } from '../../src/runtime-playbooks/adapters/tara-outreach.js';
import { createTenantRecordsAdapter } from '../../src/runtime-playbooks/adapters/tenant-records.js';
import { createLeadTimelineAdapter } from '../../src/runtime-playbooks/adapters/lead-timeline.js';
import { createChildPlaybookAdapter } from '../../src/runtime-playbooks/adapters/child-playbook.js';
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

test('Gmail adapter creates one provider draft per accepted message through generic execute', async () => {
  const created = [];
  const adapter = createGmailRuntimeAdapter({
    prisma: { hyperRoom: { async findFirst() { return { userId: '44444444-4444-4444-8444-444444444444' }; } } },
    runTool: async (tool, args) => {
      assert.equal(tool, 'gmail_create_draft');
      created.push(args);
      return { draftId: `draft-${created.length}`, messageId: `message-${created.length}`, threadId: `thread-${created.length}` };
    },
  });
  const result = await adapter.execute({
    config: { action: 'prepare_drafts' },
    inputs: { 'artifacts.message_record': [{
      id: 'message-artifact-1', key: 'message_record', source_refs: ['source:1'],
      data: { recipient: 'lead@example.test', subject: 'Grounded subject', body: 'Grounded body', lead_ref: 'lead-1', delivery_requested: true },
    }] },
  }, context());
  assert.equal(created.length, 1);
  assert.equal(result.artifacts[0].key, 'draft_record');
  assert.equal(result.artifacts[0].data.message_ref, 'message-artifact-1');
  assert.equal(result.artifacts[0].data.delivery_requested, true);
});

test('Gmail adapter persists an uncertain outcome for a provider timeout instead of replaying it', async () => {
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
  const result = await adapter.execute({ inputs: { 'artifacts.draft_record': [{ id: 'draft-artifact-1', data: { draft_ref: 'draft-1' } }] } }, context());
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].key, 'action_uncertain');
  assert.equal(result.artifacts[0].data.input_ref, 'draft-artifact-1');
});

test('Gmail adapter declares a resumable capability wait when the tenant is not connected', async () => {
  const adapter = createGmailRuntimeAdapter({
    prisma: {
      hyperRoom: { async findFirst() { return { userId: '44444444-4444-4444-8444-444444444444' }; } },
    },
    runTool: async () => { throw new Error('gmail not connected for this user - connect it on the Connectors page'); },
  });
  const result = await adapter.execute({
    config: { action: 'prepare_drafts' },
    inputs: { 'artifacts.message_record': [{
      id: 'message-artifact-1', key: 'message_record', source_refs: ['source:1'],
      data: { recipient: 'lead@example.test', subject: 'Hello', body: 'Grounded body' },
    }] },
  }, context());
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.waiting_for.types, ['capability.connected']);
  assert.equal(result.waiting_for.capability, 'gmail');
  assert.equal(result.waiting_for.correlation_path, 'data.capability');
  assert.deepEqual(result.waiting_for.correlation_values, ['gmail']);
  assert.equal(result.waiting_for.presentation.next_action, 'connect_capability');
});

test('TARA Outreach adapter starts one exact authorized call and retains its provider correlation', async () => {
  const requests = [];
  const adapter = createTaraOutreachRuntimeAdapter({
    prisma: {}, baseUrl: 'http://control.test', apiKey: 'internal-test-key',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ target: {
        id: 'target-1',
        resultRef: { sessionId: 'session-1', taraCallLegId: 'call-leg-1' },
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const contract = {
    id: 'call-contract-1', key: 'call_contract', source_refs: ['source:instruction'],
    data: { campaign_ref: 'campaign-1', target_ref: 'target-1', phone: '+49123456789' },
  };
  const result = await adapter.execute({
    config: { action: 'deliver', input_key: 'call_contract', output_key: 'call_receipt' },
    inputs: { 'artifacts.call_contract': [contract] },
  }, context());
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://control.test/internal/hyper/outreach/runtime-call/start');
  assert.equal(requests[0].options.headers['X-API-Key'], 'internal-test-key');
  assert.equal(result.artifacts[0].key, 'call_receipt');
  assert.equal(result.artifacts[0].data.input_ref, contract.id);
  assert.equal(result.artifacts[0].data.provider_receipt_id, 'call-leg-1');
  assert.equal(result.artifacts[0].data.correlation_ref, 'session-1');
  const monitored = await adapter.monitor({
    config: { input_key: 'call_receipt', output_key: 'call_subscription' },
    inputs: { 'artifacts.call_receipt': result.artifacts },
  }, context());
  assert.equal(monitored.artifacts[0].data.correlation_ref, 'session-1');
});

test('TARA Outreach adapter does not dial an ambiguous multi-recipient exact-call batch', async () => {
  let requestCount = 0;
  const adapter = createTaraOutreachRuntimeAdapter({
    prisma: {}, baseUrl: 'http://control.test', apiKey: 'internal-test-key',
    fetchImpl: async () => { requestCount += 1; throw new Error('must_not_run'); },
  });
  const result = await adapter.execute({
    config: { action: 'deliver', input_key: 'call_contract', rejection_key: 'call_rejection' },
    inputs: { 'artifacts.call_contract': [
      { id: 'contract-1', data: { campaign_ref: 'campaign-1' } },
      { id: 'contract-2', data: { campaign_ref: 'campaign-1' } },
    ] },
  }, context());
  assert.equal(requestCount, 0);
  assert.equal(result.artifacts.length, 2);
  assert.equal(result.artifacts.every((artifact) => artifact.key === 'call_rejection'), true);
});

test('lead timeline adapter persists one call outcome and updates only its tenant-owned target', async () => {
  const journals = [];
  const updates = [];
  const adapter = createLeadTimelineAdapter({ prisma: {
    hyperRoom: { async findFirst() { return { userId: '44444444-4444-4444-8444-444444444444' }; } },
    growthJournal: {
      async findFirst() { return null; },
      async create({ data }) { const row = { id: 'journal-1', ...data }; journals.push(row); return row; },
    },
    outreachTarget: {
      async findFirst(query) {
        assert.equal(query.where.campaign.orgId, context().orgId);
        return { id: 'target-1', resultRef: { sessionId: 'session-1' } };
      },
      async update({ data }) { updates.push(data); return { id: 'target-1', ...data }; },
    },
  } });
  const analysis = { id: 'analysis-1', source_refs: ['tara-call:call-1'], data: {
    terminal_state: 'call_completed', summary: 'Requested a summary.', outcome: 'summary_requested',
    sentiment: 'interested', objections: [], lead_notes: 'Send the requested summary.',
    tara_learnings: ['Lead prefers written context.'], next_action: { action_type: 'send_summary' },
  } };
  const result = await adapter.execute({
    config: { input_key: 'call_analysis', contract_key: 'call_contract' },
    inputs: {
      'artifacts.call_analysis': [analysis],
      'artifacts.call_contract': [{ id: 'contract-1', data: { target_ref: 'target-1', lead_ref: 'lead-1' } }],
    },
  }, context());
  assert.equal(journals.length, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].state, 'analyzed');
  assert.equal(updates[0].resultRef.callAnalysis.next_action.action_type, 'send_summary');
  assert.equal(result.artifacts[0].data.input_ref, 'analysis-1');
});

test('child playbook adapter dispatches one ordered unfinished child and carries only safe learning', async () => {
  const created = [];
  const prisma = {
    runtimePlaybookRun: {
      async findMany() { return [{
        id: 'child-1', itemKey: '+49111111111', status: 'COMPLETED', terminalState: 'call_completed', position: 0,
        artifacts: [{ artifactKey: 'call_analysis', data: { safe_generalized_learning: ['Open with the concrete operational problem.'], lead_notes: 'private' } }],
      }]; },
      async findFirst() { return { id: 'parent-1', trigger: {}, context: { request: {} }, scopeKey: 'global' }; },
    },
  };
  const adapter = createChildPlaybookAdapter({ prisma, getService: () => ({
    async createSelectedAssignment(input) { created.push(input); return { run: { id: 'child-2', status: 'ACTIVE' } }; },
  }) });
  const result = await adapter.execute({ config: {
    source_key: 'call_brief', items_path: 'data', item_key_path: 'phone',
    child_playbook_id: 'outreach.voice-call-to-outcome', child_playbook_version: 2,
  }, inputs: { 'artifacts.call_brief': [
    { id: 'brief-1', data: { phone: '+49111111111', personal_notes: 'first lead private' } },
    { id: 'brief-2', data: { phone: '+49222222222', personal_notes: 'second lead private' } },
  ] } }, { ...context(), runId: 'parent-1', stageId: 'dispatch_next_call' });
  assert.equal(created.length, 1);
  assert.equal(created[0].itemKey, '+49222222222');
  assert.deepEqual(created[0].context.safe_prior_learning, ['Open with the concrete operational problem.']);
  assert.equal(JSON.stringify(created[0].context).includes('first lead private'), false);
  assert.equal(result.artifacts[0].data.item_key, '+49222222222');
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

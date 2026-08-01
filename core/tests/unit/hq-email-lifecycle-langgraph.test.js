import assert from 'node:assert/strict';
import test from 'node:test';

import { Command, MemorySaver } from '@langchain/langgraph';

import {
  EMAIL_LIFECYCLE_STATUS,
  compileEmailLifecycle,
} from '../../src/hq-runtime/langgraph/email-lifecycle.js';
import { createEmailLifecycleRuntime } from '../../src/hq-runtime/langgraph/email-lifecycle-runtime.js';
import { createEmailRoomExecutor } from '../../src/hq-runtime/langgraph/email-room-executor.js';
import { createPostgresCheckpointer } from '../../src/hq-runtime/langgraph/postgres-checkpointer.js';

function createDomainStore(prospects) {
  const prospectMap = new Map(prospects.map((prospect) => [prospect.id, { ...prospect }]));
  const drafts = new Map();
  const receipts = new Map();
  const followUpDrafts = new Map();
  const followUpReceipts = new Map();

  return {
    prospectMap,
    drafts,
    receipts,
    followUpDrafts,
    followUpReceipts,
    async listAcceptedProspects({ organizationId }) {
      return [...prospectMap.values()].filter((prospect) => prospect.organizationId === organizationId);
    },
    async getAcceptedProspect({ organizationId, prospectId }) {
      const prospect = prospectMap.get(prospectId);
      return prospect?.organizationId === organizationId ? { ...prospect } : null;
    },
    async upsertDraft(value) {
      const key = `${value.organizationId}:${value.executionId}:${value.prospectId}`;
      const draft = { id: `draft:${key}`, ...value };
      drafts.set(key, draft);
      return { ...draft };
    },
    async listDrafts({ organizationId, executionId }) {
      return [...drafts.values()].filter((draft) => (
        draft.organizationId === organizationId && draft.executionId === executionId
      )).map((draft) => ({ ...draft }));
    },
    async getDraft({ organizationId, executionId, prospectId }) {
      return drafts.get(`${organizationId}:${executionId}:${prospectId}`) || null;
    },
    async upsertReceipt(value) {
      const key = `${value.organizationId}:${value.executionId}:${value.prospectId}:${value.touch}`;
      const existing = receipts.get(key);
      if (existing) return { ...existing };
      const receipt = { id: `receipt:${key}`, ...value };
      receipts.set(key, receipt);
      return { ...receipt };
    },
    async listReceipts({ organizationId, executionId }) {
      return [...receipts.values()].filter((receipt) => (
        receipt.organizationId === organizationId && receipt.executionId === executionId
      )).map((receipt) => ({ ...receipt }));
    },
    async getFollowUpDraft({ organizationId, executionId, prospectId, touch }) {
      return followUpDrafts.get(`${organizationId}:${executionId}:${prospectId}:${touch}`) || null;
    },
    async upsertFollowUpDraft(value) {
      const key = `${value.organizationId}:${value.executionId}:${value.prospectId}:${value.touch}`;
      const draft = { id: `follow-up-draft:${key}`, ...value };
      followUpDrafts.set(key, draft);
      return { ...draft };
    },
    async getFollowUpReceipt({ organizationId, executionId, prospectId, touch }) {
      return followUpReceipts.get(`${organizationId}:${executionId}:${prospectId}:${touch}`) || null;
    },
    async upsertFollowUpReceipt(value) {
      const key = `${value.organizationId}:${value.executionId}:${value.prospectId}:${value.touch}`;
      const existing = followUpReceipts.get(key);
      if (existing) return { ...existing };
      const receipt = { id: `follow-up-receipt:${key}`, ...value };
      followUpReceipts.set(key, receipt);
      return { ...receipt };
    },
  };
}

function createRoomExecutor({ failOnceFor, rejectOnceFor } = {}) {
  const draftCalls = new Map();
  let governanceCalls = 0;
  return {
    draftCalls,
    get governanceCalls() { return governanceCalls; },
    async draftEmail({ prospect, repair }) {
      const calls = (draftCalls.get(prospect.id) || 0) + 1;
      draftCalls.set(prospect.id, calls);
      if (failOnceFor === prospect.id && calls === 1) {
        throw new Error(`injected_room_failure:${prospect.id}`);
      }
      const intentionallyInvalid = rejectOnceFor === prospect.id && !repair;
      return {
        recipient: prospect.email,
        subject: `A specific idea for ${prospect.name}`,
        body: intentionallyInvalid
          ? ''
          : `Hi ${prospect.contactName}, ${prospect.outreachAngle}`,
        evidenceRefs: prospect.evidenceRefs,
      };
    },
    async governDrafts({ prospectIds, drafts }) {
      governanceCalls += 1;
      const byProspect = new Map(drafts.map((draft) => [draft.prospectId, draft]));
      const repairIds = prospectIds.filter((id) => {
        const draft = byProspect.get(id);
        return !draft?.recipient || !draft?.subject || !draft?.body || !draft?.evidenceRefs?.length;
      });
      return {
        accepted: repairIds.length === 0,
        repairIds,
        issues: repairIds.map((id) => ({ prospectId: id, code: 'draft_incomplete' })),
      };
    },
    async draftFollowUp({ prospect, touch }) {
      return {
        recipient: prospect.email,
        subject: `Following up on the idea for ${prospect.name}`,
        body: `Hi ${prospect.contactName}, one concise follow-up for touch ${touch}.`,
        evidenceRefs: prospect.evidenceRefs,
      };
    },
    async governFollowUp({ draft }) {
      return { accepted: Boolean(draft?.recipient && draft?.subject && draft?.body) };
    },
  };
}

function createProvider({ timeoutAfterAcceptFor } = {}) {
  const accepted = new Map();
  const attempts = new Map();
  const timedOut = new Set();
  return {
    accepted,
    attempts,
    async sendEmail({ idempotencyKey }) {
      attempts.set(idempotencyKey, (attempts.get(idempotencyKey) || 0) + 1);
      if (!accepted.has(idempotencyKey)) {
        accepted.set(idempotencyKey, {
          providerMessageId: `message:${idempotencyKey}`,
          providerThreadId: `thread:${idempotencyKey}`,
          status: 'sent',
        });
      }
      if (timeoutAfterAcceptFor && idempotencyKey.endsWith(`:${timeoutAfterAcceptFor}`)
        && !timedOut.has(idempotencyKey)) {
        timedOut.add(idempotencyKey);
        throw new Error('injected_timeout_after_provider_accept');
      }
      return accepted.get(idempotencyKey);
    },
  };
}

function prospects(organizationId = 'org-a') {
  return ['p1', 'p2', 'p3'].map((id, index) => ({
    id,
    organizationId,
    name: `Prospect ${index + 1}`,
    contactName: `Contact ${index + 1}`,
    email: `contact${index + 1}@example.test`,
    outreachAngle: `your verified initiative ${index + 1} aligns with the offer.`,
    evidenceRefs: [`source:${id}`],
  }));
}

function initialState(overrides = {}) {
  return {
    executionId: 'execution-1',
    organizationId: 'org-a',
    workOrderId: 'work-order-1',
    mode: 'PREPARE',
    externalWrites: 'approval_required',
    status: EMAIL_LIFECYCLE_STATUS.LOADING,
    prospectIds: [],
    draftRefs: {},
    receiptRefs: {},
    followUpDraftRefs: {},
    followUpReceiptRefs: {},
    terminalOutcomes: {},
    processedEventIds: [],
    pendingFollowUp: null,
    events: [],
    ...overrides,
  };
}

function graphFixture(options = {}) {
  const domainStore = createDomainStore(prospects());
  const roomExecutor = createRoomExecutor(options);
  const provider = createProvider(options);
  const checkpointer = new MemorySaver();
  const graph = compileEmailLifecycle(
    { domainStore, roomExecutor, provider },
    { checkpointer },
  );
  return { graph, checkpointer, domainStore, roomExecutor, provider };
}

test('prepare-only reaches artifact readiness without sending', async () => {
  const fixture = graphFixture();
  const result = await fixture.graph.invoke(initialState(), {
    configurable: { thread_id: 'prepare-only' },
  });

  assert.equal(result.status, EMAIL_LIFECYCLE_STATUS.READY_FOR_APPROVAL);
  assert.equal(fixture.domainStore.drafts.size, 3);
  assert.equal(fixture.provider.accepted.size, 0);
  assert.equal(Object.keys(result.receiptRefs).length, 0);
});

test('partial parallel failure resumes only the failed prospect branch', async () => {
  const fixture = graphFixture({ failOnceFor: 'p2' });
  const config = { configurable: { thread_id: 'partial-resume' } };

  await assert.rejects(
    fixture.graph.invoke(initialState(), config),
    /injected_room_failure:p2/,
  );
  assert.equal(fixture.roomExecutor.draftCalls.get('p1'), 1);
  assert.equal(fixture.roomExecutor.draftCalls.get('p2'), 1);
  assert.equal(fixture.roomExecutor.draftCalls.get('p3'), 1);

  const result = await fixture.graph.invoke(null, config);
  assert.equal(result.status, EMAIL_LIFECYCLE_STATUS.READY_FOR_APPROVAL);
  assert.equal(fixture.roomExecutor.draftCalls.get('p1'), 1);
  assert.equal(fixture.roomExecutor.draftCalls.get('p2'), 2);
  assert.equal(fixture.roomExecutor.draftCalls.get('p3'), 1);
  assert.equal(fixture.domainStore.drafts.size, 3);
});

test('governance repairs only the rejected prospect draft', async () => {
  const fixture = graphFixture({ rejectOnceFor: 'p2' });
  const result = await fixture.graph.invoke(initialState(), {
    configurable: { thread_id: 'targeted-repair' },
  });

  assert.equal(result.status, EMAIL_LIFECYCLE_STATUS.READY_FOR_APPROVAL);
  assert.equal(fixture.roomExecutor.draftCalls.get('p1'), 1);
  assert.equal(fixture.roomExecutor.draftCalls.get('p2'), 2);
  assert.equal(fixture.roomExecutor.draftCalls.get('p3'), 1);
  assert.equal(fixture.roomExecutor.governanceCalls, 2);
});

test('approval interrupt resumes the same execution before any send', async () => {
  const fixture = graphFixture();
  const config = { configurable: { thread_id: 'approval-resume' } };
  const paused = await fixture.graph.invoke(initialState({ mode: 'AUTONOMOUS' }), config);

  assert.equal(paused.__interrupt__.length, 1);
  assert.equal(paused.__interrupt__[0].value.type, 'email_outreach_approval');
  assert.equal(fixture.provider.accepted.size, 0);

  const waiting = await fixture.graph.invoke(
    new Command({ resume: { approved: true } }),
    config,
  );
  assert.equal(waiting.__interrupt__.length, 1);
  assert.equal(waiting.__interrupt__[0].value.type, 'email_provider_event_or_deadline');
  assert.equal(fixture.provider.accepted.size, 3);
  assert.equal(fixture.domainStore.receipts.size, 3);
});

test('ambiguous provider timeout is reconciled without a duplicate send', async () => {
  const fixture = graphFixture({ timeoutAfterAcceptFor: 'p2' });
  const config = { configurable: { thread_id: 'ambiguous-send' } };

  const approvalPause = await fixture.graph.invoke(initialState({
    mode: 'AUTONOMOUS',
    externalWrites: 'auto',
  }), config).catch((error) => error);
  assert.match(String(approvalPause), /injected_timeout_after_provider_accept/);
  assert.equal(fixture.provider.accepted.size, 3);
  assert.equal(fixture.domainStore.receipts.size, 2);

  const waiting = await fixture.graph.invoke(null, config);
  assert.equal(waiting.__interrupt__[0].value.type, 'email_provider_event_or_deadline');
  assert.equal(fixture.provider.accepted.size, 3);
  assert.equal(fixture.domainStore.receipts.size, 3);
  assert.equal(fixture.provider.attempts.get('execution-1:touch-1:p1'), 1);
  assert.equal(fixture.provider.attempts.get('execution-1:touch-1:p2'), 2);
  assert.equal(fixture.provider.attempts.get('execution-1:touch-1:p3'), 1);
});

test('reply events advance one prospect and keep waiting for the others', async () => {
  const fixture = graphFixture();
  const config = { configurable: { thread_id: 'reply-events' } };
  const waiting = await fixture.graph.invoke(initialState({
    mode: 'AUTONOMOUS',
    externalWrites: 'auto',
  }), config);
  assert.equal(waiting.__interrupt__[0].value.type, 'email_provider_event_or_deadline');

  const afterReply = await fixture.graph.invoke(new Command({ resume: {
    id: 'provider-event-1',
    type: 'positive_reply',
    prospectId: 'p1',
  } }), config);
  assert.equal(afterReply.status, EMAIL_LIFECYCLE_STATUS.REPLY_RECEIVED);
  assert.equal(afterReply.terminalOutcomes.p1, EMAIL_LIFECYCLE_STATUS.REPLY_RECEIVED);
  assert.equal(afterReply.__interrupt__[0].value.type, 'email_provider_event_or_deadline');
});

test('duplicate provider event is ignored and does not change the outcome', async () => {
  const fixture = graphFixture();
  const config = { configurable: { thread_id: 'duplicate-events' } };
  await fixture.graph.invoke(initialState({
    mode: 'AUTONOMOUS',
    externalWrites: 'auto',
  }), config);
  const event = { id: 'provider-event-1', type: 'positive_reply', prospectId: 'p1' };
  await fixture.graph.invoke(new Command({ resume: event }), config);
  const duplicate = await fixture.graph.invoke(new Command({ resume: event }), config);

  assert.equal(duplicate.terminalOutcomes.p1, EMAIL_LIFECYCLE_STATUS.REPLY_RECEIVED);
  assert.equal(duplicate.processedEventIds.filter((id) => id === event.id).length, 1);
  assert.ok(duplicate.events.some((entry) => entry.type === 'duplicate_email_event_ignored'));
});

test('execution wrapper prevents cross-tenant resume and state inspection', async () => {
  const fixture = graphFixture();
  const executions = new Map();
  const runtime = createEmailLifecycleRuntime({
    graph: fixture.graph,
    checkpointer: fixture.checkpointer,
    executionRegistry: {
      async create(value) {
        if (executions.has(value.executionId)) throw new Error('execution_exists');
        executions.set(value.executionId, { ...value });
        return { ...value };
      },
      async get(executionId) {
        return executions.get(executionId) || null;
      },
    },
  });

  await runtime.start(initialState({
    mode: 'AUTONOMOUS',
    externalWrites: 'auto',
  }));
  await assert.rejects(
    runtime.resume({
      organizationId: 'org-b',
      executionId: 'execution-1',
      value: { id: 'event-x', type: 'positive_reply', prospectId: 'p1' },
    }),
    /email_lifecycle_execution_not_found/,
  );
  await assert.rejects(
    runtime.getState({ organizationId: 'org-b', executionId: 'execution-1' }),
    /email_lifecycle_execution_not_found/,
  );
  await assert.rejects(
    runtime.listCheckpoints({ organizationId: 'org-b', executionId: 'execution-1' }),
    /email_lifecycle_execution_not_found/,
  );
});

test('runtime exposes exact checkpoint tuple, history, point-in-time state, replay, and deletion', async () => {
  const fixture = graphFixture();
  const executions = new Map();
  const runtime = createEmailLifecycleRuntime({
    graph: fixture.graph,
    checkpointer: fixture.checkpointer,
    executionRegistry: {
      async create(value) {
        executions.set(value.executionId, { ...value });
        return { ...value };
      },
      async get(executionId) { return executions.get(executionId) || null; },
    },
  });

  const result = await runtime.start(initialState({ mode: 'PREPARE' }));
  assert.equal(result.status, EMAIL_LIFECYCLE_STATUS.READY_FOR_APPROVAL);
  assert.match(executions.get('execution-1').threadId, /^hq:org-a:email:execution-1:v1$/);

  const checkpoints = await runtime.listCheckpoints({
    organizationId: 'org-a', executionId: 'execution-1', limit: 100,
  });
  assert.ok(checkpoints.length >= 3);
  assert.ok(checkpoints.every((row) => row.checkpointId));
  const firstPage = await runtime.listCheckpoints({
    organizationId: 'org-a', executionId: 'execution-1', limit: 2,
  });
  const secondPage = await runtime.listCheckpoints({
    organizationId: 'org-a', executionId: 'execution-1', limit: 2,
    beforeCheckpointId: firstPage.at(-1).checkpointId,
  });
  assert.equal(firstPage.length, 2);
  assert.ok(secondPage.length > 0);
  assert.equal(firstPage.some((row) => (
    secondPage.some((next) => next.checkpointId === row.checkpointId)
  )), false);
  const selected = checkpoints.at(-2) || checkpoints.at(-1);

  const tuple = await runtime.getCheckpoint({
    organizationId: 'org-a', executionId: 'execution-1',
    checkpointId: selected.checkpointId,
  });
  assert.equal(tuple.checkpointId, selected.checkpointId);

  const historicalState = await runtime.getState({
    organizationId: 'org-a', executionId: 'execution-1',
    checkpointId: selected.checkpointId,
  });
  assert.equal(historicalState.config.configurable.checkpoint_id, selected.checkpointId);

  const history = await runtime.getStateHistory({
    organizationId: 'org-a', executionId: 'execution-1', limit: 100,
  });
  assert.equal(history.length, checkpoints.length);
  assert.ok(history.some((row) => row.next.length > 0));

  const replayed = await runtime.replayFromCheckpoint({
    organizationId: 'org-a', executionId: 'execution-1',
    checkpointId: checkpoints[0].checkpointId,
  });
  assert.equal(replayed.status, EMAIL_LIFECYCLE_STATUS.READY_FOR_APPROVAL);

  const deletion = await runtime.deleteCheckpoints({
    organizationId: 'org-a', executionId: 'execution-1',
  });
  assert.equal(deletion.deleted, true);
  assert.equal(await runtime.getCheckpoint({
    organizationId: 'org-a', executionId: 'execution-1',
  }), null);
  assert.equal(fixture.domainStore.drafts.size, 3);
});

test('official Postgres checkpointer factory rejects missing URLs and unsafe schemas before setup', async () => {
  await assert.rejects(
    createPostgresCheckpointer(),
    /langgraph_checkpoint_database_url_missing/,
  );
  await assert.rejects(
    createPostgresCheckpointer({
      connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused',
      schema: 'unsafe-schema;drop table checkpoints',
    }),
    /langgraph_checkpoint_schema_invalid/,
  );
});

test('no-reply deadline creates and sends a governed follow-up in auto mode', async () => {
  const fixture = graphFixture();
  const config = { configurable: { thread_id: 'automatic-follow-up' } };
  await fixture.graph.invoke(initialState({
    mode: 'AUTONOMOUS',
    externalWrites: 'auto',
  }), config);

  const waitingAgain = await fixture.graph.invoke(new Command({ resume: {
    id: 'deadline-p1-touch-1',
    type: 'no_reply_deadline',
    prospectId: 'p1',
    touch: 1,
  } }), config);

  assert.equal(waitingAgain.__interrupt__[0].value.type, 'email_provider_event_or_deadline');
  assert.equal(fixture.domainStore.followUpDrafts.size, 1);
  assert.equal(fixture.domainStore.followUpReceipts.size, 1);
  assert.equal(fixture.provider.accepted.size, 4);
  assert.equal(fixture.provider.attempts.get('execution-1:touch-2:p1'), 1);
  assert.ok(waitingAgain.events.some((entry) => entry.type === 'follow_up_sent'));
});

test('manual policy pauses again before sending a newly generated follow-up', async () => {
  const fixture = graphFixture();
  const config = { configurable: { thread_id: 'manual-follow-up' } };
  await fixture.graph.invoke(initialState({ mode: 'AUTONOMOUS' }), config);
  await fixture.graph.invoke(new Command({ resume: { approved: true } }), config);

  const followUpApproval = await fixture.graph.invoke(new Command({ resume: {
    id: 'deadline-p1-touch-1',
    type: 'no_reply_deadline',
    prospectId: 'p1',
    touch: 1,
  } }), config);
  assert.equal(followUpApproval.__interrupt__[0].value.type, 'email_follow_up_approval');
  assert.equal(fixture.provider.accepted.size, 3);

  const waitingAgain = await fixture.graph.invoke(
    new Command({ resume: { approved: true } }),
    config,
  );
  assert.equal(waitingAgain.__interrupt__[0].value.type, 'email_provider_event_or_deadline');
  assert.equal(fixture.provider.accepted.size, 4);
});

test('lifecycle completes only after every prospect reaches a terminal outcome', async () => {
  const fixture = graphFixture();
  const config = { configurable: { thread_id: 'all-terminal' } };
  await fixture.graph.invoke(initialState({
    mode: 'AUTONOMOUS',
    externalWrites: 'auto',
  }), config);

  await fixture.graph.invoke(new Command({ resume: {
    id: 'reply-p1', type: 'positive_reply', prospectId: 'p1', touch: 1,
  } }), config);
  await fixture.graph.invoke(new Command({ resume: {
    id: 'unsubscribe-p2', type: 'unsubscribe', prospectId: 'p2', touch: 1,
  } }), config);
  const completed = await fixture.graph.invoke(new Command({ resume: {
    id: 'bounce-p3', type: 'bounce', prospectId: 'p3', touch: 1,
  } }), config);

  assert.equal(completed.status, EMAIL_LIFECYCLE_STATUS.COMPLETED);
  assert.equal(Object.keys(completed.terminalOutcomes).length, 3);
  assert.equal(completed.terminalOutcomes.p1, EMAIL_LIFECYCLE_STATUS.REPLY_RECEIVED);
  assert.equal(completed.terminalOutcomes.p2, EMAIL_LIFECYCLE_STATUS.SUPPRESSED);
  assert.equal(completed.terminalOutcomes.p3, EMAIL_LIFECYCLE_STATUS.BOUNCED);
  assert.equal(completed.__interrupt__, undefined);
});

test('one waiting lifecycle does not block an independent execution', async () => {
  const fixture = graphFixture();
  const waiting = await fixture.graph.invoke(initialState({
    executionId: 'execution-waiting',
    mode: 'AUTONOMOUS',
    externalWrites: 'auto',
  }), { configurable: { thread_id: 'execution-waiting' } });
  assert.equal(waiting.__interrupt__[0].value.type, 'email_provider_event_or_deadline');

  const prepared = await fixture.graph.invoke(initialState({
    executionId: 'execution-independent',
    mode: 'PREPARE',
  }), { configurable: { thread_id: 'execution-independent' } });
  assert.equal(prepared.status, EMAIL_LIFECYCLE_STATUS.READY_FOR_APPROVAL);
  assert.equal(fixture.domainStore.drafts.size, 6);

  const waitingSnapshot = await fixture.graph.getState({
    configurable: { thread_id: 'execution-waiting' },
  });
  assert.equal(waitingSnapshot.tasks[0].interrupts[0].value.type, 'email_provider_event_or_deadline');
});

test('runtime blocks unsupported checkpoint versions instead of guessing a migration', async () => {
  const fixture = graphFixture();
  const executions = new Map();
  const registry = {
    async create(value) {
      executions.set(value.executionId, { ...value });
      return { ...value };
    },
    async get(executionId) { return executions.get(executionId) || null; },
  };
  const runtime = createEmailLifecycleRuntime({
    graph: fixture.graph,
    checkpointer: fixture.checkpointer,
    executionRegistry: registry,
    supportedGraphVersions: [1],
  });
  await runtime.start(initialState({
    executionId: 'versioned-execution',
    mode: 'AUTONOMOUS',
    externalWrites: 'auto',
  }));
  executions.get('versioned-execution').graphVersion = 0;

  await assert.rejects(
    runtime.resume({
      organizationId: 'org-a',
      executionId: 'versioned-execution',
      value: { id: 'event-1', type: 'bounce', prospectId: 'p1' },
    }),
    /email_lifecycle_graph_version_unsupported:0/,
  );
});

test('lifecycle executes drafting through the existing HQ Room contract boundary', async () => {
  const domainStore = createDomainStore(prospects());
  const provider = createProvider();
  const roomCalls = [];
  const roomExecutor = createEmailRoomExecutor({
    async invokeRoom(request) {
      roomCalls.push(request);
      const target = request.order.input_snapshot.target;
      const criteria = request.order.acceptance_criteria;
      const checks = criteria.map((criterion) => ({
        type: 'artifact', criterion, passed: true, observed: 'typed draft returned',
      }));
      return {
        result: {
          contract_version: 'work-order-result.v2',
          status: 'completed',
          subtasks: [{ id: `draft-${target.prospect_id}`, status: 'completed', checks }],
          acceptance: criteria.map((criterion) => ({ criterion, met: true })),
          completion_requirements: request.order.input_snapshot.completion_requirements
            .map((requirement) => ({ type: requirement.type, met: true })),
          deliverables: [{
            type: 'email_draft',
            prospect_id: target.prospect_id,
            recipient: target.verified_recipient,
            subject: `A verified idea for ${target.company_name}`,
            body: `Hi ${target.contact_name}, ${target.outreach_angle}`,
            evidence_refs: request.order.evidence_refs,
          }],
          evidence_refs: request.order.evidence_refs,
          gaps: [], blockers: [], needs_input: [],
        },
      };
    },
  });
  const graph = compileEmailLifecycle(
    { domainStore, roomExecutor, provider },
    { checkpointer: new MemorySaver() },
  );

  const result = await graph.invoke(initialState(), {
    configurable: { thread_id: 'real-room-contract-boundary' },
  });
  assert.equal(result.status, EMAIL_LIFECYCLE_STATUS.READY_FOR_APPROVAL);
  assert.equal(roomCalls.length, 3);
  assert.ok(roomCalls.every((call) => JSON.parse(call.executionContext).contract === 'hq-work-order.v2'));
  assert.equal(domainStore.drafts.size, 3);
  assert.equal(provider.accepted.size, 0);
});

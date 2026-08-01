import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmailRoomExecutor } from '../../src/hq-runtime/langgraph/email-room-executor.js';

const prospect = {
  id: 'prospect-1',
  name: 'Berlin Regulated Systems GmbH',
  contactName: 'Ada Example',
  email: 'ada@example.test',
  fitRationale: 'Operates regulated industrial systems in Berlin.',
  outreachAngle: 'Connect sovereign AI memory to documented compliance operations.',
  evidenceRefs: ['source:prospect-1'],
};

function acceptedResponse(overrides = {}) {
  const criterion = 'Return exactly one email_draft deliverable for prospect prospect-1';
  const recipientCriterion = 'Recipient must equal the verified address ada@example.test';
  const contentCriterion = 'Subject, body, and at least one evidence reference must be present';
  const checks = [criterion, recipientCriterion, contentCriterion].map((value) => ({
    type: 'artifact', criterion: value, passed: true, observed: 'verified',
  }));
  return {
    result: {
      contract_version: 'work-order-result.v2',
      status: 'completed',
      subtasks: [{ id: 'draft', status: 'completed', checks }],
      acceptance: [criterion, recipientCriterion, contentCriterion].map((value) => ({
        criterion: value, met: true,
      })),
      completion_requirements: [
        { type: 'email_drafts', met: true },
        { type: 'external_actions', met: true },
      ],
      gaps: [],
      blockers: [],
      needs_input: [],
      evidence_refs: ['source:prospect-1'],
      deliverables: [{
        type: 'email_draft',
        prospect_id: 'prospect-1',
        recipient: 'ada@example.test',
        subject: 'A compliance-memory idea for Berlin Regulated Systems',
        body: 'Hi Ada, your documented compliance operations align with sovereign AI memory.',
        evidence_refs: ['source:prospect-1'],
      }],
      ...overrides,
    },
  };
}

test('adapter sends one exact private work-order envelope and returns a typed draft', async () => {
  const calls = [];
  const executor = createEmailRoomExecutor({
    async invokeRoom(request) {
      calls.push(request);
      return acceptedResponse();
    },
  });
  const draft = await executor.draftEmail({
    organizationId: 'org-a',
    workOrderId: 'parent-work-order',
    executionId: 'execution-1',
    prospect,
    repair: false,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].roomTag, 'outreach');
  const envelope = JSON.parse(calls[0].executionContext);
  assert.equal(envelope.contract, 'hq-work-order.v2');
  assert.equal(envelope.kind, 'email_drafting');
  assert.equal(envelope.target.verified_recipient, prospect.email);
  assert.equal(envelope.authority.external_writes, false);
  assert.equal(envelope.completion_requirements[0].type, 'email_drafts');
  assert.equal(envelope.upstream_result.deliverables[0].kind, 'prospect_records');
  assert.equal(envelope.upstream_result.deliverables[0].records[0].email, prospect.email);
  assert.match(calls[0].userMessage, /Do not send/);
  assert.deepEqual(draft, {
    recipient: prospect.email,
    subject: 'A compliance-memory idea for Berlin Regulated Systems',
    body: 'Hi Ada, your documented compliance operations align with sovereign AI memory.',
    evidenceRefs: ['source:prospect-1'],
  });
});

test('adapter normalizes the authoritative email_drafts artifact emitted by the Room engine', async () => {
  const response = acceptedResponse({
    deliverables: [{
      kind: 'email_drafts',
      source: 'room_worker',
      record_count: 1,
      records: [{
        prospect_company: prospect.name,
        to: prospect.email,
        subject: 'A sovereign-memory idea for regulated operations',
        body: 'Your regulated industrial operations align with a sovereign memory approach.',
        rationale: prospect.outreachAngle,
        source_url: 'source:prospect-1',
      }],
    }],
  });
  const executor = createEmailRoomExecutor({ async invokeRoom() { return response; } });

  const draft = await executor.draftEmail({
    organizationId: 'org-a', workOrderId: 'wo', executionId: 'exec', prospect,
  });

  assert.equal(draft.recipient, prospect.email);
  assert.equal(draft.subject, 'A sovereign-memory idea for regulated operations');
  assert.deepEqual(draft.evidenceRefs, ['source:prospect-1']);
});

test('adapter rejects a prose-only Room success without the typed contract', async () => {
  const executor = createEmailRoomExecutor({
    async invokeRoom() {
      return { status: 'complete', summary: 'The emails are ready.' };
    },
  });
  await assert.rejects(
    executor.draftEmail({
      organizationId: 'org-a', workOrderId: 'wo', executionId: 'exec', prospect,
    }),
    /email_room_work_incomplete:prospect-1/,
  );
});

test('adapter rejects an unverified recipient even when Room governance says complete', async () => {
  const response = acceptedResponse();
  response.result.deliverables[0].recipient = 'different@example.test';
  const executor = createEmailRoomExecutor({ async invokeRoom() { return response; } });

  await assert.rejects(
    executor.draftEmail({
      organizationId: 'org-a', workOrderId: 'wo', executionId: 'exec', prospect,
    }),
    /email_room_recipient_not_verified:prospect-1/,
  );
});

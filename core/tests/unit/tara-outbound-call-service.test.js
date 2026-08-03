import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaraOutboundCallService } from '../../src/tara/outbound-call-service.js';

function harness(fetchImpl) {
  const campaign = { id: '11111111-1111-4111-8111-111111111111' };
  const contact = { id: '22222222-2222-4222-8222-222222222222' };
  let attempt = {
    id: '33333333-3333-4333-8333-333333333333', orgId: '44444444-4444-4444-8444-444444444444',
    userId: '55555555-5555-4555-8555-555555555555', campaignId: campaign.id, contactId: contact.id,
    actionKey: 'tara:test', status: 'queued', reconciliationState: 'pending', provider: 'deepgram',
    requestedSessionId: null, sessionId: null, callLegId: null, outboundActionId: null,
  };
  const prisma = {
    taraCampaign: { async findFirst() { return campaign; } },
    taraCampaignContact: { async upsert() { return contact; }, async update() { return contact; } },
    taraCallAttempt: {
      async upsert() { return { ...attempt }; },
      async findUnique() { return { ...attempt }; },
      async update({ data }) { attempt = { ...attempt, ...data }; return { ...attempt }; },
    },
    outboundAction: { async findFirst() { return null; }, async findUnique() { return null; } },
    taraCall: { async findFirst() { return null; } },
    runtimePerformanceMetric: { async create() { return {}; } },
  };
  return { prisma, service: createTaraOutboundCallService({ prisma, fetchImpl }), getAttempt: () => attempt };
}

function input() {
  return {
    actionKey: 'tara:test', executionRef: '66666666-6666-4666-8666-666666666666',
    orgId: '44444444-4444-4444-8444-444444444444', userId: '55555555-5555-4555-8555-555555555555',
    to: '+491234567890', goal: 'Discuss the verified objective.',
    provider: { provider: 'deepgram', baseUrl: 'http://tara.test', revision: 1 },
    providerPayload: {},
  };
}

test('uncertain TARA dial is retained and never replayed before reconciliation', async () => {
  let calls = 0;
  const h = harness(async () => { calls += 1; throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }); });
  await assert.rejects(h.service.execute(input()), (error) => error.classification === 'uncertain_transport');
  assert.equal(calls, 1);
  assert.equal(h.getAttempt().reconciliationState, 'uncertain');
  await assert.rejects(h.service.execute(input()), /tara_call_outcome_uncertain/);
  assert.equal(calls, 1);
});

test('confirmed TARA 4xx is rejected rather than retained as uncertain', async () => {
  const h = harness(async () => new Response(JSON.stringify({ error: 'invalid recipient' }), {
    status: 400, headers: { 'Content-Type': 'application/json' },
  }));
  await assert.rejects(h.service.execute(input()), (error) => (
    error.classification === 'deterministic_response' && error.reconciliationRequired === false
  ));
  assert.equal(h.getAttempt().reconciliationState, 'rejected');
  assert.equal(h.getAttempt().disposition, 'rejected');
});

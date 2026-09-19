import assert from 'node:assert/strict';
import test from 'node:test';

import { CreditService } from '../../src/billing/credit-service.js';
import { planLimitBody } from '../../src/billing/limit-response.js';

test('an ended partner referral is denied before a new credit transaction starts', async () => {
  let transactions = 0;
  const service = new CreditService({
    prisma: { $transaction: async () => { transactions += 1; } },
    planStore: { getOrgPlan: async () => ({
      id: 'free', limits: { monthlyCredits: 0 }, entitlement: {
        source: 'partner_referral', status: 'manual_review', grantId: 'grant-1',
      },
    }) },
    usageService: {},
  });

  const result = await service.reserve({ orgId: 'org-1', service: 'chat_turn', units: 1, idempotencyKey: 'turn-1' });
  assert.equal(result.admitted, false);
  assert.equal(result.check.referralTrial, true);
  assert.equal(transactions, 0);
  assert.deepEqual(planLimitBody(result.check, 'credits'), {
    error: 'credits_exhausted', code: 'credits_exhausted',
    message: 'Your referral trial has ended. Talk to the founder to continue.',
    resource: 'credits', plan: 'enterprise', limit: 0, current: null, remaining: 0,
    suggested_plan: null, upgrade_url: '/hivemind/app/billing', referral_trial: true,
    commercial_action: 'talk_to_founder',
  });
});

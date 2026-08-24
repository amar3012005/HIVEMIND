import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PlanEnforcer } from '../../src/billing/plan-enforcer.js';
import { getPlan } from '../../src/billing/plans.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

function makeEnforcer({ plan = getPlan('free'), usage = {}, daily = {}, memoryCount = 0, meetingSeconds = 0 } = {}) {
  const prisma = {
    memory: { count: async () => memoryCount },
    $queryRawUnsafe: async (query) => String(query).includes('SUM("duration_sec")') ? [{ secs: meetingSeconds }] : [{ c: 0 }],
    platformIntegration: { count: async () => 0 },
    hyperRoom: { count: async () => 0 },
    userOrganization: { count: async () => 1 },
  };
  const tracker = {
    getUsage: async () => ({
      tokensProcessed: 0, searchQueries: 0, knowledgeBaseUploads: 0,
      knowledgeBasePages: 0, memoriesIngested: 0, deepResearchJobs: 0,
      webIntelJobs: 0, graphQueries: 0, taraUsage: 0, connectorCount: 0,
      ...usage,
    }),
    getDailySnapshot: async () => daily,
    getCumulativeUsage: async () => ({}),
  };
  return new PlanEnforcer(prisma, { getOrgPlan: async () => plan }, tracker);
}

describe('PlanEnforcer B2C limits', () => {
  it('does not block chat on the legacy daily token cap', async () => {
    const enforcer = makeEnforcer({ daily: { tokens: 99_900 } });
    const result = await enforcer.checkLimit(ORG_ID, 'tokens', 101);
    assert.equal(result.allowed, true);
  });

  it('blocks Pro at its monthly token allocation without overage bypass', async () => {
    const enforcer = makeEnforcer({
      plan: getPlan('pro'),
      usage: { tokensProcessed: 9_999_950 },
      daily: { tokens: 10 },
    });
    const result = await enforcer.checkLimit(ORG_ID, 'tokens', 51);
    assert.equal(result.allowed, false);
    assert.equal(result.limit, 10_000_000);
  });

  it('combines recall and graph queries into one monthly budget', async () => {
    const enforcer = makeEnforcer({
      usage: { searchQueries: 9_500, graphQueries: 500 },
      daily: { searches: 10, graphQueries: 10 },
    });
    const result = await enforcer.checkLimit(ORG_ID, 'searches', 1);
    assert.equal(result.allowed, false);
    assert.equal(result.current, 10_000);
  });

  it('checks the live memory total rather than monthly ingestion', async () => {
    const enforcer = makeEnforcer({ memoryCount: 1_000 });
    const result = await enforcer.checkLimit(ORG_ID, 'memories', 1);
    assert.equal(result.allowed, false);
    assert.equal(result.current, 1_000);
  });

  it('keeps upload counts as internal telemetry rather than a billable limit', async () => {
    const enforcer = makeEnforcer({
      usage: { knowledgeBaseUploads: 10_000 },
      daily: { uploads: 10_000 },
    });
    assert.equal((await enforcer.checkLimit(ORG_ID, 'uploads', 1)).allowed, true);
    assert.equal(Object.hasOwn(await enforcer.getUsageSummary(ORG_ID), 'uploads'), false);
  });

  it('reports meeting usage from durable duration seconds', async () => {
    const summary = await makeEnforcer({ meetingSeconds: 3_601 }).getUsageSummary(ORG_ID);
    assert.deepEqual(summary.meetingMinutes, { used: 61, usedSeconds: 3_601, limit: 30 });
  });

  it('blocks meeting transcription at the exact second boundary', async () => {
    const result = await makeEnforcer({ meetingSeconds: 30 * 60 }).checkLimit(ORG_ID, 'meetingMinutes', 0);
    assert.equal(result.allowed, false);
    assert.equal(result.currentSeconds, 30 * 60);
  });

  it('uses the subscription meeting-minute limits as one ground truth', () => {
    assert.equal(getPlan('free').limits.meetingMinutesPerMonth, 30);
    assert.equal(getPlan('pro').limits.meetingMinutesPerMonth, 100);
    assert.equal(getPlan('scale').limits.meetingMinutesPerMonth, 500);
    assert.equal(getPlan('enterprise').limits.meetingMinutesPerMonth, -1);
  });

  it('does not enforce entitlement-overridden daily token limits', async () => {
    const plan = { ...getPlan('pro'), limits: { ...getPlan('pro').limits, llmTokensPerDay: 500 } };
    const enforcer = makeEnforcer({ plan, daily: { tokens: 500 } });
    const result = await enforcer.checkLimit(ORG_ID, 'tokens', 1);
    assert.equal(result.allowed, true);
  });

  it('fails closed for enforced daily limits when the ledger cannot be verified', async () => {
    const enforcer = makeEnforcer({ daily: null });
    const result = await enforcer.checkLimit(ORG_ID, 'searches', 1);
    assert.equal(result.allowed, false);
    assert.equal(result.status, 503);
  });

  it('returns daily budgets and threshold reminders from the effective plan', async () => {
    const enforcer = makeEnforcer({
      usage: { tokensProcessed: 800_000 },
      daily: { tokens: 80_000 },
      memoryCount: 100,
    });
    const summary = await enforcer.getUsageSummary(ORG_ID);
    assert.equal(summary.daily.tokens.limit, 100_000);
    assert.equal(summary.daily.tokens.used, 80_000);
    assert.ok(summary.reminders.some(reminder => reminder.resource === 'tokens' && reminder.period === 'daily'));
    assert.ok(summary.reminders.some(reminder => reminder.resource === 'tokens' && reminder.period === 'monthly'));
  });

  it('blocks TARA and HyperAgents at daily limits', async () => {
    const tara = makeEnforcer({ daily: { taraSeconds: 300 } });
    const hyper = makeEnforcer({ daily: { hyperAgentRuns: 5 } });
    assert.equal((await tara.checkLimit(ORG_ID, 'taraSeconds', 1)).allowed, false);
    assert.equal((await hyper.checkLimit(ORG_ID, 'hyperAgentRuns', 1)).allowed, false);
  });

  it('blocks TARA and HyperAgents at monthly limits', async () => {
    const tara = makeEnforcer({ usage: { taraSeconds: 1_800 }, daily: { taraSeconds: 0 } });
    const hyper = makeEnforcer({ usage: { hyperAgentRuns: 25 }, daily: { hyperAgentRuns: 0 } });
    assert.equal((await tara.checkLimit(ORG_ID, 'taraSeconds', 1)).allowed, false);
    assert.equal((await hyper.checkLimit(ORG_ID, 'hyperAgentRuns', 1)).allowed, false);
  });
});

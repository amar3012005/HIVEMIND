import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPlan, getAllPlans, isFeatureEnabled, getLimit } from '../../src/billing/plans.js';

describe('Plans', () => {
  it('publishes the B2C free, plus, pro, and scale tiers plus enterprise', () => {
    assert.deepEqual(getAllPlans().map(plan => plan.id), ['free', 'plus', 'pro', 'scale', 'enterprise']);
  });

  it('defines daily and monthly hard limits for free', () => {
    const plan = getPlan('free');
    assert.equal(plan.price, 0);
    assert.equal(plan.limits.llmTokensPerDay, 100_000);
    assert.equal(plan.limits.llmTokensPerMonth, 1_000_000);
    assert.equal(plan.limits.searchQueriesPerDay, 1_000);
    assert.equal(plan.limits.knowledgeBasePagesPerDay, 25);
    assert.equal(plan.limits.knowledgeBasePagesPerMonth, 100);
    assert.equal(plan.overage, null);
  });

  it('keeps paid B2C tiers hard-capped until metered overage is enabled', () => {
    const pro = getPlan('pro');
    const scale = getPlan('scale');
    assert.equal(pro.price, 79);
    assert.equal(pro.limits.llmTokensPerDay, 1_000_000);
    assert.equal(pro.limits.llmTokensPerMonth, 10_000_000);
    assert.equal(pro.overage, null);
    assert.equal(scale.price, 239);
    assert.equal(scale.limits.llmTokensPerDay, 10_000_000);
    assert.equal(scale.limits.llmTokensPerMonth, 100_000_000);
    assert.equal(scale.overage, null);
  });

  it('gates OS and VOICE according to the product ladder', () => {
    assert.equal(isFeatureEnabled('free', 'operatingSystem'), true);
    assert.equal(isFeatureEnabled('plus', 'operatingSystem'), false);
    assert.equal(isFeatureEnabled('pro', 'operatingSystem'), true);
    assert.equal(isFeatureEnabled('pro', 'taraVoiceAgent'), false);
    assert.equal(isFeatureEnabled('scale', 'taraVoiceAgent'), true);
    assert.equal(isFeatureEnabled('enterprise', 'taraVoiceAgent'), true);
    assert.equal(isFeatureEnabled('free', 'webIntelligence'), true);
    assert.equal(isFeatureEnabled('free', 'llmObserver'), true);
  });

  it('keeps enterprise limits unlimited', () => {
    const plan = getPlan('enterprise');
    assert.equal(plan.limits.llmTokensPerDay, -1);
    assert.equal(plan.limits.llmTokensPerMonth, -1);
    assert.equal(plan.limits.searchQueriesPerDay, -1);
    assert.equal(plan.limits.maxUsers, -1);
  });

  it('defaults unknown plans to free', () => {
    assert.equal(getPlan('nonexistent').id, 'free');
  });

  it('returns canonical limit fields', () => {
    assert.equal(getLimit('free', 'llmTokensPerMonth'), 1_000_000);
    assert.equal(getLimit('scale', 'maxUsers'), 25);
  });
});

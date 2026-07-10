import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPlan,
  getAllPlans,
  getPersonalPlans,
  getEnterpriseBillingPhase,
  isEnterpriseWorkspace,
  isFeatureEnabled,
  getLimit,
  PLANS,
} from '../../src/billing/plans.js';

describe('Plans', () => {
  it('has 4 tiers', () => {
    assert.equal(getAllPlans().length, 4);
  });

  it('keeps self-serve plans personal only', () => {
    assert.deepEqual(getPersonalPlans().map((plan) => plan.id), ['free', 'pro', 'scale']);
  });

  it('maps enterprise workspaces to onboarding then runway', () => {
    const future = new Date(Date.now() + 60_000);
    assert.equal(isEnterpriseWorkspace({ plan: 'enterprise' }), true);
    assert.equal(getEnterpriseBillingPhase({ plan: 'enterprise', trialEndsAt: future }), 'onboarding');
    assert.equal(getEnterpriseBillingPhase({ plan: 'enterprise', trialEndsAt: new Date(0) }), 'runway');
  });

  it('free plan has correct limits', () => {
    const plan = getPlan('free');
    assert.equal(plan.price, 0);
    assert.equal(plan.limits.llmTokensPerMonth, 1_000_000);
    assert.equal(plan.limits.searchQueriesPerMonth, 10_000);
    assert.equal(plan.limits.maxConnectors, 3);
    assert.equal(plan.overage, null);
  });

  it('pro plan costs EUR 79', () => {
    const plan = getPlan('pro');
    assert.equal(plan.price, 79);
    assert.equal(plan.currency, 'EUR');
    assert.equal(plan.limits.llmTokensPerMonth, 10_000_000);
  });

  it('keeps agent swarm available on every personal tier', () => {
    assert.equal(isFeatureEnabled('scale', 'agentSwarm'), true);
    assert.equal(isFeatureEnabled('pro', 'agentSwarm'), true);
    assert.equal(isFeatureEnabled('free', 'agentSwarm'), true);
  });

  it('keeps web intelligence available on the free tier', () => {
    assert.equal(isFeatureEnabled('free', 'webIntelligence'), true);
    assert.equal(isFeatureEnabled('pro', 'webIntelligence'), true);
    assert.equal(isFeatureEnabled('scale', 'webIntelligence'), true);
  });

  it('enterprise has unlimited everything', () => {
    const plan = getPlan('enterprise');
    assert.equal(plan.limits.llmTokensPerMonth, -1);
    assert.equal(plan.limits.searchQueriesPerMonth, -1);
    assert.equal(plan.limits.maxUsers, -1);
  });

  it('unknown plan defaults to free', () => {
    const plan = getPlan('nonexistent');
    assert.equal(plan.id, 'free');
  });

  it('getLimit returns correct value', () => {
    assert.equal(getLimit('free', 'llmTokensPerMonth'), 1_000_000);
    assert.equal(getLimit('scale', 'maxUsers'), 25);
  });

  it('keeps LLM observer available on the free tier', () => {
    assert.equal(isFeatureEnabled('free', 'llmObserver'), true);
    assert.equal(isFeatureEnabled('pro', 'llmObserver'), true);
  });
});

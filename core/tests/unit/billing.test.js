import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPlan, getAllPlans, isFeatureEnabled, getLimit, PLANS } from '../../src/billing/plans.js';

describe('Plans', () => {
  it('has 4 tiers', () => {
    assert.equal(getAllPlans().length, 4);
  });

  it('free plan has correct limits', () => {
    const plan = getPlan('free');
    assert.equal(plan.price, 0);
    assert.equal(plan.limits.tokensPerMonth, 1_000_000);
    assert.equal(plan.limits.searchQueriesPerMonth, 10_000);
    assert.equal(plan.limits.maxConnectors, 1);
    assert.equal(plan.overage, null);
  });

  it('pro plan costs EUR 19', () => {
    const plan = getPlan('pro');
    assert.equal(plan.price, 19);
    assert.equal(plan.currency, 'EUR');
    assert.equal(plan.limits.tokensPerMonth, 5_000_000);
  });

  it('scale plan has agent swarm enabled', () => {
    assert.equal(isFeatureEnabled('scale', 'agentSwarm'), true);
    assert.equal(isFeatureEnabled('pro', 'agentSwarm'), false);
    assert.equal(isFeatureEnabled('free', 'agentSwarm'), false);
  });

  it('web intelligence is pro+ only', () => {
    assert.equal(isFeatureEnabled('free', 'webIntelligence'), false);
    assert.equal(isFeatureEnabled('pro', 'webIntelligence'), true);
    assert.equal(isFeatureEnabled('scale', 'webIntelligence'), true);
  });

  it('enterprise has unlimited everything', () => {
    const plan = getPlan('enterprise');
    assert.equal(plan.limits.tokensPerMonth, -1);
    assert.equal(plan.limits.searchQueriesPerMonth, -1);
    assert.equal(plan.limits.maxUsers, -1);
  });

  it('unknown plan defaults to free', () => {
    const plan = getPlan('nonexistent');
    assert.equal(plan.id, 'free');
  });

  it('getLimit returns correct value', () => {
    assert.equal(getLimit('free', 'tokensPerMonth'), 1_000_000);
    assert.equal(getLimit('scale', 'maxUsers'), 25);
  });

  it('LLM observer is pro+ only', () => {
    assert.equal(isFeatureEnabled('free', 'llmObserver'), false);
    assert.equal(isFeatureEnabled('pro', 'llmObserver'), true);
  });
});

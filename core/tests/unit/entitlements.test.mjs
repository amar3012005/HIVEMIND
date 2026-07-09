import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeEntitlementPlan, normalizeReferralCode } from '../../src/billing/entitlements.js';
import { UsageTracker } from '../../src/billing/usage-tracker.js';

describe('referral entitlements', () => {
  it('normalizes codes without accepting browser-defined terms', () => {
    assert.equal(normalizeReferralCode(' gtm2026 '), 'GTM2026');
    assert.equal(normalizeReferralCode(null), '');
  });

  it('overrides only the campaign limits while retaining plan features', () => {
    const plan = mergeEntitlementPlan('enterprise', { maxUsers: 12, llmTokensPerMonth: 5_000_000 });
    assert.equal(plan.id, 'enterprise');
    assert.equal(plan.limits.maxUsers, 12);
    assert.equal(plan.limits.llmTokensPerMonth, 5_000_000);
    assert.equal(plan.features.ssoSaml, true);
  });

  it('records cumulative memory usage without any decrement path', async () => {
    const statements = [];
    const tracker = new UsageTracker({
      $executeRawUnsafe: async (sql) => { statements.push(sql); },
    });
    await tracker.recordMemory('11111111-1111-4111-8111-111111111111');
    assert.equal(statements.length, 2);
    assert.match(statements[1], /org_usage_cumulative/);
    assert.match(statements[1], /\+ \$2/);
    assert.doesNotMatch(statements[1], /DELETE|-/i);
  });

});

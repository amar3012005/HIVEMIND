import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS, hasPermission } from '../../src/auth/permissions.js';
import { USAGE_METRICS } from '../../src/billing/metric-registry.js';

test('billing separates shared allowance visibility from commercial authority', () => {
  assert.equal(hasPermission(['member'], 'billing', 'read'), true);
  assert.equal(hasPermission(['member'], 'billing', 'manage'), false);
  assert.equal(hasPermission(['org_admin'], 'billing', 'manage'), true);
  assert.equal(hasPermission(['org_owner'], 'billing', 'manage'), true);
  assert.ok(PERMISSIONS.billing.read.has('guest'));
});

test('usage registry covers every persisted commercial projection metric', () => {
  for (const [type, descriptor] of Object.entries(USAGE_METRICS)) {
    assert.ok(descriptor.metric, `${type} has canonical metric`);
    if (type === 'credits') continue; // append-only commercial ledger; deliberately no legacy projection
    assert.ok(descriptor.month, `${type} has monthly projection`);
    assert.ok(descriptor.daily, `${type} has daily projection`);
  }
});

test('the registry explicitly includes the new tenant-billed product surfaces', () => {
  assert.equal(USAGE_METRICS.taraSeconds.metric, 'tara_seconds');
  assert.equal(USAGE_METRICS.webIntel.metric, 'web_intel_jobs');
  assert.equal(USAGE_METRICS.hyperAgentRuns.metric, 'hyperagent_runs');
  assert.equal(USAGE_METRICS.credits.metric, 'credits_consumed');
});

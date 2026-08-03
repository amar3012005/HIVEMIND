import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertHqTransition,
  normalizeAuthorityPolicy,
  resolveAuthorityPreference,
  validateWorkResultPacket,
} from '../../src/hq-runtime/contracts.js';
import { eventCursor, playbookQueueStatus, projectCampaignAuthorityPreview } from '../../src/hq-runtime/routes.js';

test('HQ runtime permits only explicit state transitions', () => {
  assert.doesNotThrow(() => assertHqTransition('INACTIVE', 'OBSERVING'));
  assert.doesNotThrow(() => assertHqTransition('WAITING', 'REVIEWING'));
  assert.throws(
    () => assertHqTransition('INACTIVE', 'DELEGATING'),
    /hq_runtime_invalid_transition/,
  );
});

test('HQ authority defaults external consequences to approval', () => {
  assert.deepEqual(normalizeAuthorityPolicy(), {
    internal_autonomy: true,
    external_writes: 'approval_required',
    external_default: 'unconfigured',
    gate_overrides: {},
    outbound_messages: 'unconfigured',
    outbound_calls: 'unconfigured',
    outbound_campaigns: 'unconfigured',
    spending: 'approval_required',
    deletion: 'approval_required',
    policy_changes: 'approval_required',
    emergency_stop: true,
  });
});

test('HQ resolves opaque gate policy before the organization default', () => {
  const policy = normalizeAuthorityPolicy({
    external_default: 'manual',
    gate_overrides: { 'opaque.policy.v1': 'auto' },
  });
  assert.equal(resolveAuthorityPreference(policy, 'opaque.policy.v1'), 'auto');
  assert.equal(resolveAuthorityPreference(policy, 'another.policy.v1'), 'manual');
});

test('specialist result packets are compact and normalized', () => {
  assert.deepEqual(validateWorkResultPacket({
    result: { finding: 'conversion path missing' },
    actions: [{ type: 'research' }],
    recommendation: 'ITERATE',
    source_refs: ['baseline:1'],
  }), {
    result: { finding: 'conversion path missing' },
    actions: [{ type: 'research' }],
    metrics: {},
    cost: {},
    failures: [],
    blockers: [],
    recommendation: 'iterate',
    source_refs: ['baseline:1'],
  });
  assert.throws(
    () => validateWorkResultPacket({ recommendation: 'launch_everything' }),
    /hq_work_result_invalid_recommendation/,
  );
});

test('HQ stream resumes from the greatest valid cursor', () => {
  assert.equal(eventCursor('18', '22'), 22n);
  assert.equal(eventCursor('invalid', '7'), 7n);
  assert.equal(eventCursor('-1', null), 0n);
});

test('HQ queue projects semantic playbook waits truthfully', () => {
  assert.equal(playbookQueueStatus({ status: 'WAITING_AUTHORITY' }), 'WAITING_FOR_AUTHORITY');
  assert.equal(playbookQueueStatus({ status: 'WAITING_EVENT', waitingFor: { types: ['capability.connected'] } }), 'WAITING_FOR_CONNECTOR');
  assert.equal(playbookQueueStatus({ status: 'WAITING_EVENT', waitingFor: { types: ['provider.reply', 'wait.timeout'] } }), 'MONITORING');
  assert.equal(playbookQueueStatus({ status: 'NEEDS_INTERVENTION' }), 'NEEDS_ATTENTION');
});

test('HQ campaign authority projection exposes only the current immutable launch batch', () => {
  const preview = projectCampaignAuthorityPreview({
    id: 'campaign-1', name: 'Awareness', status: 'READY_FOR_APPROVAL', requestedChannels: ['x_organic'],
    currentPlanVersionId: 'plan-2',
    actions: [
      { id: 'old', planVersionId: 'plan-1', channel: 'x_organic', payload: { text: 'Old' }, assets: [] },
      {
        id: 'current', planVersionId: 'plan-2', channel: 'x_organic', actionType: 'POST', position: 0,
        status: 'READY', scheduledAt: new Date('2026-08-03T12:00:00.000Z'), payload: { text: 'Exact copy', asset_id: 'asset-1' },
        assets: [{ id: 'asset-1', status: 'READY', storageKey: 'private/path', contentType: 'image/png', metadata: { alt_text: 'Proof' } }],
      },
    ],
  });
  assert.equal(preview.actions.length, 1);
  assert.equal(preview.actions[0].payload.text, 'Exact copy');
  assert.equal(preview.actions[0].assets[0].content_url, '/v1/campaigns/campaign-1/assets/asset-1/content');
  assert.equal('storageKey' in preview.actions[0].assets[0], false);
});

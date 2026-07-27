import test from 'node:test';
import assert from 'node:assert/strict';

import { applyCampaignActionEdit, campaignActionRanges, campaignAgentWhere, canonicalHash, createCampaign, editCampaignAction, getCampaignSettings, markCampaignRepairing, normalizeCampaignInput, regenerateCampaign, syncCampaignMetrics, updateCampaignSettings, validateCampaignBundle } from '../../src/campaigns/service.js';
import { assertTransition, campaignChannelExecutionEnabled, campaignExecutionChannels, campaignsV2Enabled, campaignWorkerEnabled } from '../../src/campaigns/state.js';
import { getCampaignCapabilities } from '../../src/campaigns/capabilities.js';
import { buildCampaignDisplayMessage, buildCampaignKickoff, buildCampaignRoomDispatch, normalizeCampaignRoomEvent } from '../../src/campaigns/contracts.js';
import { handleCampaignDispatchError, handleCampaignRoomEvent } from '../../src/campaigns/pipeline.js';

const baseInput = {
  idempotency_key: 'create-1', objective: 'LEAD_GENERATION',
  goal: 'Generate qualified conversations for the new product launch.',
  channels: ['x_organic'], duration_days: 14, timezone: 'Europe/Berlin',
};

test('campaign input requires caller idempotency and validates time boundaries', () => {
  assert.equal(normalizeCampaignInput(baseInput).creationKey, 'create-1');
  assert.throws(() => normalizeCampaignInput({ ...baseInput, idempotency_key: '' }), { code: 'idempotency_key_required' });
  assert.throws(() => normalizeCampaignInput({ ...baseInput, duration_days: 0 }), { code: 'invalid_duration' });
  assert.throws(() => normalizeCampaignInput({ ...baseInput, timezone: 'Mars/Olympus' }), { code: 'invalid_timezone' });
  assert.throws(() => normalizeCampaignInput({ ...baseInput, destination_url: 'javascript:alert(1)' }), { code: 'invalid_destination_url' });
});

test('campaign input supports organization-owned full autonomy', () => {
  assert.equal(normalizeCampaignInput({ ...baseInput, autonomy_mode: 'FULL_AUTO' }).autonomyMode, 'FULL_AUTO');
  assert.throws(() => normalizeCampaignInput({ ...baseInput, autonomy_mode: 'UNSAFE_AUTO' }), /Unknown approval mode/);
});

test('campaign autonomy settings are organization scoped and admin controlled', async () => {
  const oldEnabled = process.env.CAMPAIGNS_V2_ENABLED; const oldOrgs = process.env.CAMPAIGNS_V2_ORG_IDS;
  process.env.CAMPAIGNS_V2_ENABLED = 'true'; process.env.CAMPAIGNS_V2_ORG_IDS = 'org-a';
  let update;
  const prisma = {
    organization: {
      async findUnique({ where }) { assert.deepEqual(where, { id: 'org-a' }); return { campaignAutonomyMode: 'MANUAL_REVIEW' }; },
      async update(args) { update = args; return args.data; },
    },
    userOrganization: { async findUnique() { return { role: 'admin' }; } },
  };
  try {
    assert.deepEqual(await getCampaignSettings({ prisma, orgId: 'org-a' }), { autonomy_mode: 'MANUAL_REVIEW' });
    assert.deepEqual(await updateCampaignSettings({ prisma, orgId: 'org-a', userId: 'user-a', autonomyMode: 'AUTO' }), { autonomy_mode: 'AUTO' });
    assert.deepEqual(update, { where: { id: 'org-a' }, data: { campaignAutonomyMode: 'AUTO' } });
  } finally {
    if (oldEnabled === undefined) delete process.env.CAMPAIGNS_V2_ENABLED; else process.env.CAMPAIGNS_V2_ENABLED = oldEnabled;
    if (oldOrgs === undefined) delete process.env.CAMPAIGNS_V2_ORG_IDS; else process.env.CAMPAIGNS_V2_ORG_IDS = oldOrgs;
  }
});

test('campaign input accepts plan-only channels but rejects unknown channels', () => {
  const input = normalizeCampaignInput({ ...baseInput, channels: ['linkedin', 'google_ads'] });
  assert.deepEqual(input.channels, ['linkedin', 'google_ads']);
  assert.match(input.requirements[1].text, /approval-ready linkedin actions/);
  assert.throws(() => normalizeCampaignInput({ ...baseInput, channels: ['unknown_network'] }), { code: 'unknown_campaign_channel' });
});

test('campaign capabilities separate planning readiness from publishing readiness', async () => {
  const previous = { enabled: process.env.CAMPAIGNS_V2_ENABLED, orgs: process.env.CAMPAIGNS_V2_ORG_IDS };
  process.env.CAMPAIGNS_V2_ENABLED = 'true';
  process.env.CAMPAIGNS_V2_ORG_IDS = '*';
  const prisma = {
    xAdsCredential: { findUnique: async () => null },
    nangoConnection: { findFirst: async () => null },
    platformIntegration: { findFirst: async () => null },
    taraRuntimeConfig: { findUnique: async () => null },
  };
  try {
    const capabilities = await getCampaignCapabilities({ prisma, userId: 'user-1', orgId: 'org-1' });
    const meta = capabilities.channels.find((channel) => channel.id === 'meta');
    const x = capabilities.channels.find((channel) => channel.id === 'x_organic');
    assert.equal(meta.planning_ready, true);
    assert.equal(meta.execution_ready, false);
    assert.equal(meta.execution_reason, 'adapter_not_available');
    assert.equal(x.planning_ready, true);
    assert.equal(x.executable, false);
    assert.equal(x.evidence.status, 'not_connected');
    assert.equal(typeof capabilities.checked_at, 'string');
  } finally {
    if (previous.enabled === undefined) delete process.env.CAMPAIGNS_V2_ENABLED; else process.env.CAMPAIGNS_V2_ENABLED = previous.enabled;
    if (previous.orgs === undefined) delete process.env.CAMPAIGNS_V2_ORG_IDS; else process.env.CAMPAIGNS_V2_ORG_IDS = previous.orgs;
  }
});

test('campaign capabilities expose safe account evidence without credentials', async () => {
  const previous = { enabled: process.env.CAMPAIGNS_V2_ENABLED, orgs: process.env.CAMPAIGNS_V2_ORG_IDS };
  process.env.CAMPAIGNS_V2_ENABLED = 'true';
  process.env.CAMPAIGNS_V2_ORG_IDS = '*';
  const connectedAt = new Date('2026-07-27T10:00:00.000Z');
  const prisma = {
    xAdsCredential: { findUnique: async ({ where }) => where.orgId_userId_authKind.authKind === 'OAUTH2' ? {
      status: 'active', xUserId: '42', xUsername: 'singulance', scopes: ['tweet.read', 'tweet.write'],
      expiresAt: new Date('2030-01-01T00:00:00.000Z'), connectedAt, updatedAt: connectedAt,
    } : null },
    nangoConnection: { findFirst: async () => null },
    platformIntegration: { findFirst: async () => null },
    taraRuntimeConfig: { findUnique: async () => null },
  };
  try {
    const capabilities = await getCampaignCapabilities({ prisma, userId: 'user-1', orgId: 'org-1' });
    const x = capabilities.channels.find((channel) => channel.id === 'x_organic');
    assert.equal(x.connected, true);
    assert.equal(x.evidence.identity.username, 'singulance');
    assert.deepEqual(x.evidence.scopes, ['tweet.read', 'tweet.write']);
    assert.equal(JSON.stringify(capabilities).includes('accessToken'), false);
    assert.equal(JSON.stringify(capabilities).includes('connectionId'), false);
  } finally {
    if (previous.enabled === undefined) delete process.env.CAMPAIGNS_V2_ENABLED; else process.env.CAMPAIGNS_V2_ENABLED = previous.enabled;
    if (previous.orgs === undefined) delete process.env.CAMPAIGNS_V2_ORG_IDS; else process.env.CAMPAIGNS_V2_ORG_IDS = previous.orgs;
  }
});

test('campaign capabilities keep X connected when a refresh token can renew an expired access token', async () => {
  const expired = new Date(Date.now() - 60_000);
  const prisma = {
    xAdsCredential: {
      async findUnique({ where }) {
        if (where.orgId_userId_authKind.authKind !== 'OAUTH2') return null;
        return { status: 'active', xUserId: 'x-1', xUsername: 'connected', scopes: ['tweet.write'], expiresAt: expired, refreshTokenEncrypted: 'encrypted', connectedAt: new Date(), updatedAt: new Date() };
      },
    },
    nangoConnection: { async findFirst() { return null; } },
    platformIntegration: { async findFirst() { return null; } },
    taraRuntimeConfig: { async findUnique() { return null; } },
  };
  const capabilities = await getCampaignCapabilities({ prisma, userId: 'user-1', orgId: 'org-1' });
  const x = capabilities.channels.find((channel) => channel.id === 'x_organic');
  assert.equal(x.connected, true);
  assert.equal(x.identity.username, 'connected');
  assert.equal('refreshTokenEncrypted' in x.evidence, false);
});

test('campaign horizon and intensity produce an authoritative per-channel action range', () => {
  assert.deepEqual(campaignActionRanges({ durationDays: 14, intensity: 'focused', channels: ['x_organic'] }), {
    preset: 'focused', duration_days: 14,
    expected_actions_by_channel: { x_organic: { minimum: 6, maximum: 8 } },
    total_minimum: 6, total_maximum: 8,
  });
  const input = normalizeCampaignInput({ ...baseInput, intensity: 'high', channels: ['x_organic', 'tara'] });
  assert.deepEqual(input.brief.cadence.expected_actions_by_channel, {
    x_organic: { minimum: 9, maximum: 12 }, tara: { minimum: 5, maximum: 8 },
  });
  assert.throws(() => campaignActionRanges({ durationDays: 14, intensity: 'chaotic', channels: ['x_organic'] }), { code: 'invalid_campaign_intensity' });
});

test('bundle gate enforces the normalized campaign action range', () => {
  const campaign = {
    requestedChannels: ['x_organic'], requirements: [{ id: 'goal' }, { id: 'channel:x_organic' }],
    brief: { cadence: { expected_actions_by_channel: { x_organic: { minimum: 3, maximum: 4 } } } },
  };
  const action = { id: 'x-1', channel: 'x_organic', final_copy: 'Ready copy', payload: { text: 'Ready copy' }, scheduled_offset_minutes: 0, rationale: 'Launch' };
  const bundle = {
    strategy: 'Launch with a sequence.', audience: { rationale: 'Current followers.' }, content_pillars: ['Proof'],
    kpis: [{ name: 'Reach' }], actions: [action],
    requirement_coverage: [{ requirement_id: 'goal', action_ids: ['x-1'] }, { requirement_id: 'channel:x_organic', action_ids: ['x-1'] }],
  };
  assert.match(validateCampaignBundle(bundle, campaign).join(' '), /needs 3-4 actions/);
});

test('canonical campaign hash is stable across object key order', () => {
  assert.equal(canonicalHash({ b: 2, a: { d: 4, c: 3 } }), canonicalHash({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
});

test('bundle gate requires every channel, recipient, and requirement', () => {
  const campaign = {
    requestedChannels: ['gmail', 'tara'],
    requirements: [{ id: 'goal' }, { id: 'channel:gmail' }, { id: 'channel:tara' }],
  };
  const bundle = {
    strategy: 'Use email to establish relevance and TARA for opted-in follow-up.',
    audience: { rationale: 'Use current qualified leads only.' }, content_pillars: ['Proof'],
    kpis: [{ name: 'Qualified replies', target: 'Track from baseline', source: 'Gmail' }],
    actions: [
      { id: 'email-1', channel: 'gmail', final_copy: 'Hello', payload: { to: 'lead@example.com', subject: 'A relevant idea' }, scheduled_offset_minutes: 0, rationale: 'Establish relevance' },
      { id: 'call-1', channel: 'tara', final_copy: 'Call contract', payload: { to: '+353123456789', opening: 'Hello, this is TARA calling about your request.', lawful_basis: 'consent', country: 'IE', timezone: 'Europe/Dublin' }, scheduled_offset_minutes: 60, rationale: 'Follow up with opted-in leads' },
    ],
    requirement_coverage: [
      { requirement_id: 'goal', action_ids: ['email-1'] },
      { requirement_id: 'channel:gmail', action_ids: ['email-1'] },
      { requirement_id: 'channel:tara', action_ids: ['call-1'] },
    ],
  };
  assert.deepEqual(validateCampaignBundle(bundle, campaign), []);
  const broken = structuredClone(bundle); delete broken.actions[1].payload.opening;
  assert.match(validateCampaignBundle(broken, campaign).join(' '), /speak-first opening/);
});

test('bundle gate rejects oversized or mismatched X provider text', () => {
  const campaign = { requestedChannels: ['x_organic'], requirements: [{ id: 'goal' }, { id: 'channel:x_organic' }] };
  const bundle = {
    strategy: 'Publish a concise launch sequence.', audience: { rationale: 'Current followers.' }, content_pillars: ['Proof'],
    kpis: [{ name: 'Reach', target: 'Track from baseline', source: 'X' }],
    actions: [{ id: 'x-1', channel: 'x_organic', final_copy: 'x'.repeat(281), payload: { text: 'x'.repeat(281) }, scheduled_offset_minutes: 0, rationale: 'Launch now' }],
    requirement_coverage: [{ requirement_id: 'goal', action_ids: ['x-1'] }, { requirement_id: 'channel:x_organic', action_ids: ['x-1'] }],
  };
  assert.match(validateCampaignBundle(bundle, campaign).join(' '), /280 characters or fewer/);
  bundle.actions[0].final_copy = 'Visible copy'; bundle.actions[0].payload.text = 'Different provider copy';
  assert.match(validateCampaignBundle(bundle, campaign).join(' '), /must match final copy/);
});

test('contract v4 requires one source-grounded operating plan across intelligence and execution', () => {
  const campaign = {
    requestedChannels: ['x_organic'], requirements: [{ id: 'goal' }, { id: 'channel:x_organic' }],
    brief: { duration_days: 7, cadence: { preset: 'focused', expected_actions_by_channel: { x_organic: { minimum: 1, maximum: 2 } } } },
  };
  const action = {
    id: 'x-1', channel: 'x_organic', title: 'Proof', format: 'single_post',
    final_copy: 'A campaign should leave the room ready to run.', payload: { text: 'A campaign should leave the room ready to run.' },
    scheduled_offset_minutes: 0, rationale: 'Show the operating outcome.', creative_brief: { required: false },
    claim_status: 'verified', evidence_ids: ['ev-1'], hypothesis_id: 'proof', dependencies: ['Approved X connection'],
    success_measure: 'Establish an organic engagement baseline.', rollback_or_exit: 'Pause remaining actions if provider validation fails.',
  };
  const bundle = {
    contract_version: 4,
    objective: 'Build qualified awareness.', strategy: 'Lead with proof of completed work.',
    strategy_options: [
      { id: 'proof', name: 'Proof led', thesis: 'Show the result.', tradeoff: 'Needs product evidence.' },
      { id: 'control', name: 'Control led', thesis: 'Show approval.', tradeoff: 'Less direct.' },
      { id: 'speed', name: 'Coordination led', thesis: 'Show the workflow.', tradeoff: 'Avoid timing claims.' },
    ],
    selected_strategy_id: 'proof',
    company_grounding: { company_name: 'SINGULANCE', facts_used: ['Campaign Rooms return structured plans.'], unknowns: [] },
    campaign_horizon: { duration_days: 7, intensity: 'focused', rationale: 'A bounded message test.' },
    positioning: { statement: 'Campaign Rooms produce reviewable work.', proof_points: ['Structured Campaign Contract'] },
    audience: { rationale: 'Existing operators.', segments: [{ name: 'Operators', need: 'Controlled execution' }], safety_notes: [] },
    content_pillars: ['Proof'], kpis: [{ name: 'Qualified engagement', target: 'Baseline', source: 'X', target_type: 'baseline', evidence_ids: [] }],
    actions: [action], timeline: [{ action_id: 'x-1', phase: 'Launch', scheduled_offset_minutes: 0 }],
    safety: { guardrails: ['Use verified claims only.'], prohibited_claims: ['Guaranteed growth'] },
    measurement: { primary_kpi: 'Qualified engagement', attribution_limit: 'Engagement is not revenue.', review_cadence: '24 hours after each Post.' },
    debate_conflicts_present: true,
    debate_decisions: [{ conflict: 'Proof versus speed', decision: 'Use proof.', rationale: 'It is grounded.', dissent: 'Test speed later.' }],
    evidence: [{ id: 'ev-1', claim: 'Campaign Rooms return structured plans.', source: 'Product workflow', source_type: 'company', confidence: 'high', status: 'verified', url: '' }],
    media_plan: { currency: null, channels: [{ channel: 'x_organic', role: 'Organic awareness', rationale: 'The brief selects X.', budget_amount: 0, prerequisites: ['Approved X connection'], exclusions: ['No paid promotion'] }] },
    creative_system: { approved_claim_ids: ['ev-1'], hypotheses: [
      { id: 'proof', insight: 'Operators need finished work.', promise: 'Show the result.', hook: 'Ready to run.', cta: 'Inspect it.', channels: ['x_organic'], experiment_hypothesis: 'Proof earns qualified engagement.' },
      { id: 'control', insight: 'Operators need control.', promise: 'Keep approval explicit.', hook: 'Plan without publishing.', cta: 'Review it.', channels: ['x_organic'], experiment_hypothesis: 'Control earns trust-oriented replies.' },
    ] },
    launch_plan: { mode: 'draft_only', approval_mode: 'APPROVE_PLAN_ONCE', prerequisites: ['Confirm X identity'], blocked_by: [], ceilings: [], verification_steps: ['Read back the Post'], rollback_steps: ['Pause remaining actions'] },
    monitoring_plan: { baseline: 'Capture the pre-launch baseline.', primary_outcome: 'Qualified engagement', attribution_limit: 'Do not infer revenue.', checkpoints: [{ timing: '24 hours', metrics: ['impressions', 'engagements'], decision_rule: 'Review; do not auto-optimize.' }], optimization_requires_approval: true },
    assumptions: [], launch_checklist: ['Approve exact copy.'], risks: [],
    requirement_coverage: [{ requirement_id: 'goal', action_ids: ['x-1'] }, { requirement_id: 'channel:x_organic', action_ids: ['x-1'] }],
    quality_gate: { ready: true, checks: {
      goal_alignment: 'passed', company_grounding: 'passed', channel_completeness: 'passed', provider_validity: 'passed', schedule_completeness: 'passed',
      evidence_integrity: 'passed', creative_completeness: 'passed', launch_safety: 'passed', measurement_readiness: 'passed',
    } },
  };
  assert.deepEqual(validateCampaignBundle(bundle, campaign), []);
  const fullAutoCampaign = { ...campaign, autonomyMode: 'FULL_AUTO' };
  const fullAutoBundle = structuredClone(bundle);
  fullAutoBundle.monitoring_plan.optimization_requires_approval = false;
  assert.deepEqual(validateCampaignBundle(fullAutoBundle, fullAutoCampaign), []);
  assert.match(validateCampaignBundle(bundle, fullAutoCampaign).join(' '), /must be false for FULL_AUTO/);
  const missingLaunchSafety = structuredClone(bundle); delete missingLaunchSafety.launch_plan;
  assert.match(validateCampaignBundle(missingLaunchSafety, campaign).join(' '), /needs a launch plan/);
  const weakAction = structuredClone(bundle); delete weakAction.actions[0].rollback_or_exit;
  assert.match(validateCampaignBundle(weakAction, campaign).join(' '), /rollback or exit condition/);
  const ungroundedTarget = structuredClone(bundle); ungroundedTarget.kpis[0] = { name: 'Qualified engagement', target: '500', source: 'X', target_type: 'verified', evidence_ids: [] };
  assert.match(validateCampaignBundle(ungroundedTarget, campaign).join(' '), /verified target must reference verified evidence/);
  const assumptionCopy = structuredClone(bundle); assumptionCopy.actions[0].claim_status = 'assumption'; assumptionCopy.actions[0].evidence_ids = [];
  assert.match(validateCampaignBundle(assumptionCopy, campaign).join(' '), /cannot publish an assumption as final copy/);
  const borrowedMetric = structuredClone(bundle); borrowedMetric.actions[0].final_copy = 'Campaign Rooms are always ready in 50 ms.'; borrowedMetric.actions[0].payload.text = borrowedMetric.actions[0].final_copy;
  assert.match(validateCampaignBundle(borrowedMetric, campaign).join(' '), /claims not present in its evidence: 50 ms, always/);
});

test('action edits create a valid cloned bundle without mutating the approved source', () => {
  const source = {
    strategy: 'Launch with one approved post.', audience: { rationale: 'Current followers.' }, content_pillars: ['Proof'],
    kpis: [{ name: 'Reach', target: '100', source: 'X' }],
    actions: [{ id: 'x-1', channel: 'x_organic', title: 'Launch', final_copy: 'Old copy', payload: { text: 'Old copy' }, scheduled_offset_minutes: 0, rationale: 'Launch now' }],
    requirement_coverage: [{ requirement_id: 'goal', action_ids: ['x-1'] }, { requirement_id: 'channel:x_organic', action_ids: ['x-1'] }],
  };
  const edited = applyCampaignActionEdit(source, 'x-1', { final_copy: 'New approved copy', scheduled_offset_minutes: 30 });
  assert.equal(source.actions[0].final_copy, 'Old copy');
  assert.equal(edited.actions[0].final_copy, 'New approved copy');
  assert.equal(edited.actions[0].payload.text, 'New approved copy');
  assert.equal(edited.actions[0].scheduled_offset_minutes, 30);
  assert.deepEqual(validateCampaignBundle(edited, { requestedChannels: ['x_organic'], requirements: [{ id: 'goal' }, { id: 'channel:x_organic' }] }), []);
});

test('action removal creates a cloned bundle and preserves the source plan', () => {
  const bundle = {
    strategy: 'Launch with two approved posts.', audience: { rationale: 'Current followers.' }, content_pillars: ['Proof'],
    kpis: [{ name: 'Reach', target: '100', source: 'X' }],
    actions: [{ id: 'x-1', channel: 'x_organic', title: 'Launch', final_copy: 'Old copy', payload: { text: 'Old copy' }, scheduled_offset_minutes: 0, rationale: 'Launch now' }],
    requirement_coverage: [{ requirement_id: 'goal', action_ids: ['x-1'] }, { requirement_id: 'channel:x_organic', action_ids: ['x-1'] }],
  };
  bundle.actions.push({ ...bundle.actions[0], id: 'x-2', title: 'Follow-up', scheduled_offset_minutes: 60 });
  bundle.requirement_coverage = bundle.requirement_coverage.map((item) => ({ ...item, action_ids: ['x-1', 'x-2'] }));
  const next = applyCampaignActionEdit(bundle, 'x-1', { remove: true });
  assert.deepEqual(next.actions.map((item) => item.id), ['x-2']);
  assert.deepEqual(next.requirement_coverage[0].action_ids, ['x-2']);
  assert.deepEqual(bundle.actions.map((item) => item.id), ['x-1', 'x-2']);
  assert.deepEqual(validateCampaignBundle(next, { requestedChannels: ['x_organic'], requirements: [{ id: 'goal' }, { id: 'channel:x_organic' }] }), []);
});

test('campaign edit, regeneration, and metric commands are tenant scoped', async () => {
  const oldEnabled = process.env.CAMPAIGNS_V2_ENABLED; const oldOrgs = process.env.CAMPAIGNS_V2_ORG_IDS;
  process.env.CAMPAIGNS_V2_ENABLED = 'true'; process.env.CAMPAIGNS_V2_ORG_IDS = 'other-org';
  try {
    const prisma = { campaign: { async findFirst() { return null; } } };
    await assert.rejects(() => editCampaignAction({ prisma, orgId: 'other-org', userId: 'user-a', id: 'campaign-a', actionId: 'action-a', body: {} }), { code: 'campaign_not_found', status: 404 });
    await assert.rejects(() => regenerateCampaign({ prisma, orgId: 'other-org', userId: 'user-a', id: 'campaign-a' }), { code: 'campaign_not_found', status: 404 });
    await assert.rejects(() => syncCampaignMetrics({ prisma, orgId: 'other-org', userId: 'user-a', id: 'campaign-a' }), { code: 'campaign_not_found', status: 404 });
  } finally {
    if (oldEnabled === undefined) delete process.env.CAMPAIGNS_V2_ENABLED; else process.env.CAMPAIGNS_V2_ENABLED = oldEnabled;
    if (oldOrgs === undefined) delete process.env.CAMPAIGNS_V2_ORG_IDS; else process.env.CAMPAIGNS_V2_ORG_IDS = oldOrgs;
  }
});

test('state and rollout gates reject unsafe transitions', () => {
  assert.equal(campaignsV2Enabled('org-a', { CAMPAIGNS_V2_ENABLED: 'true', CAMPAIGNS_V2_ORG_IDS: 'org-a' }), true);
  assert.equal(campaignWorkerEnabled({ CAMPAIGNS_V2_WORKER_ENABLED: 'false' }), false);
  assert.equal(campaignWorkerEnabled({ CAMPAIGNS_V2_WORKER_ENABLED: 'true' }), true);
  assert.deepEqual([...campaignExecutionChannels({ CAMPAIGNS_V2_EXECUTION_CHANNELS: 'x_organic,unknown' })], ['x_organic']);
  assert.equal(campaignChannelExecutionEnabled('x_organic', { CAMPAIGNS_V2_WORKER_ENABLED: 'true', CAMPAIGNS_V2_EXECUTION_CHANNELS: 'x_organic' }), true);
  assert.equal(campaignChannelExecutionEnabled('gmail', { CAMPAIGNS_V2_WORKER_ENABLED: 'true', CAMPAIGNS_V2_EXECUTION_CHANNELS: 'x_organic' }), false);
  assert.equal(assertTransition('READY_FOR_APPROVAL', 'RUNNING'), true);
  assert.throws(() => assertTransition('DRAFT', 'RUNNING'), { code: 'invalid_campaign_transition' });
});

test('campaign rooms use configured draft agents but exclude paused agents', () => {
  assert.deepEqual(campaignAgentWhere('org-a'), { orgId: 'org-a', archivedAt: null, status: { not: 'paused' } });
});

test('campaign creation reuses the permanent Campaign Intelligence room and batches campaign records', async () => {
  const previous = process.env.CAMPAIGNS_V2_ENABLED;
  const previousOrgs = process.env.CAMPAIGNS_V2_ORG_IDS;
  process.env.CAMPAIGNS_V2_ENABLED = 'true';
  process.env.CAMPAIGNS_V2_ORG_IDS = 'org-a';
  const calls = []; let batch = null;
  const fixedRoom = { id: 'room-fixed', orgId: 'org-a', agentConnectors: { _domain_home: true } };
  const prisma = {
    organization: { async findUnique() { return { campaignAutonomyMode: 'MANUAL_REVIEW' }; } },
    campaign: {
      async findUnique() { return null; },
      create({ data }) { calls.push(['campaign.create', data]); return Promise.resolve({ ...data, createdAt: new Date() }); },
      update() { throw new Error('campaign.update must not run during creation'); },
    },
    hyperRoom: {
      async findFirst() { return fixedRoom; },
      create({ data }) { calls.push(['hyperRoom.create', data]); return Promise.resolve(data); },
      update({ data }) { calls.push(['hyperRoom.update', data]); return Promise.resolve({ ...fixedRoom, ...data }); },
    },
    hyperTurn: { async findFirst() { return { seq: 4 }; }, create({ data }) { calls.push(['hyperTurn.create', data]); return Promise.resolve(data); } },
    campaignRun: { create({ data }) { calls.push(['campaignRun.create', data]); return Promise.resolve({ id: 'run-a', ...data }); } },
    campaignChannel: { createMany({ data }) { calls.push(['campaignChannel.createMany', data]); return Promise.resolve({ count: data.length }); } },
    campaignEvent: { create({ data }) { calls.push(['campaignEvent.create', data]); return Promise.resolve(data); } },
    digitalEmployee: { async findMany() { return [{ id: 'agent-a' }, { id: 'agent-b' }, { id: 'agent-c' }]; } },
    xAdsCredential: { async findUnique() { return { status: 'active', xUserId: 'x-a', xUsername: 'company' }; } },
    nangoConnection: { async findFirst() { return null; } },
    platformIntegration: { async findFirst() { return null; } },
    taraRuntimeConfig: { async findUnique() { return null; } },
    async $executeRawUnsafe() { return 1; },
    async $transaction(operations) {
      if (typeof operations === 'function') return operations(this);
      batch = operations;
      return Promise.all(operations);
    },
  };
  try {
    const result = await createCampaign({ prisma, userId: 'user-a', orgId: 'org-a', body: baseInput });
    assert.equal(Array.isArray(batch), true);
    assert.equal(batch.length, 6);
    assert.deepEqual(calls.map(([name]) => name), [
      'hyperRoom.update', 'hyperRoom.update', 'campaign.create', 'hyperTurn.create', 'campaignRun.create',
      'campaignChannel.createMany', 'campaignEvent.create',
    ]);
    assert.equal(result.campaign.status, 'GENERATING');
    assert.equal(result.campaign.roomId, result.dispatch.room_id);
    assert.equal(result.campaign.roomId, 'room-fixed');
    assert.equal(calls.find(([name]) => name === 'hyperTurn.create')[1].seq, 5);
    assert.doesNotMatch(result.dispatch.user_message, /CAMPAIGN_ID|BRIEF_JSON|campaign__submit_plan/);
    assert.match(result.dispatch.execution_context, /campaign__submit_plan/);
  } finally {
    if (previous === undefined) delete process.env.CAMPAIGNS_V2_ENABLED; else process.env.CAMPAIGNS_V2_ENABLED = previous;
    if (previousOrgs === undefined) delete process.env.CAMPAIGNS_V2_ORG_IDS; else process.env.CAMPAIGNS_V2_ORG_IDS = previousOrgs;
  }
});

test('campaign room contract carries the campaign identity and completion tool', () => {
  const campaign = { id: 'campaign-a', ownerUserId: 'user-a', orgId: 'org-a', goal: 'Launch', objective: 'PRODUCT_LAUNCH', requestedChannels: ['x_organic'], brief: {}, audiencePolicy: {} };
  const kickoff = buildCampaignKickoff(campaign);
  const displayMessage = buildCampaignDisplayMessage(campaign);
  const dispatch = buildCampaignRoomDispatch({
    campaign,
    room: { id: 'room-a', goal: 'Launch room' },
    turn: { id: 'turn-a', userMessage: displayMessage },
    participantIds: ['agent-a'],
    briefSnapshot: { campaign_id: 'campaign-a' },
  });
  assert.match(kickoff, /campaign__submit_plan/);
  assert.doesNotMatch(displayMessage, /CAMPAIGN_ID|BRIEF_JSON|campaign__submit_plan/);
  assert.equal(dispatch.user_message, displayMessage);
  assert.equal(dispatch.display_message, displayMessage);
  assert.match(dispatch.execution_context, /CAMPAIGN_ID: campaign-a/);
  assert.equal(dispatch.task_tag, 'CAMPAIGN');
  assert.equal(dispatch.campaign_id, 'campaign-a');
  assert.equal(normalizeCampaignRoomEvent({ t: 'campaign_bundle', bundle: {} }).t, 'campaign_bundle');
  assert.equal(normalizeCampaignRoomEvent(null), null);
});

test('first Campaign Room event advances the durable run and records progress', async () => {
  const events = [];
  const run = { id: 'run-a', campaignId: 'campaign-a', roomId: 'room-a', turnId: 'turn-a', status: 'DISPATCHING', campaign: { orgId: 'org-a' } };
  const prisma = {
    campaignRun: {
      async findUnique() { return run; },
      async updateMany() { run.status = 'RUNNING'; return { count: 1 }; },
    },
    campaignEvent: { async create({ data }) { events.push(data); return data; } },
  };
  const result = await handleCampaignRoomEvent({ prisma, turnId: 'turn-a', event: { t: 'typing', agent: 'director' } });
  assert.equal(result.status, 'RUNNING');
  assert.equal(run.status, 'RUNNING');
  assert.equal(events[0].eventType, 'campaign_generation_started');
});

test('intermediate campaign contract gaps remain repairable until the Room seals', async () => {
  const writes = [];
  const run = { id: 'run-a', campaignId: 'campaign-a', status: 'RUNNING', campaign: { orgId: 'org-a' } };
  const prisma = {
    campaignRun: {
      async findUnique() { return run; },
      update({ data }) { writes.push(['run', data]); return Promise.resolve(data); },
    },
    campaign: { update({ data }) { writes.push(['campaign', data]); return Promise.resolve(data); } },
    campaignEvent: { create({ data }) { writes.push(['event', data]); return Promise.resolve(data); } },
    async $transaction(operations) { return Promise.all(operations); },
  };
  const result = await markCampaignRepairing({ prisma, turnId: 'turn-a', errors: ['Action A3 needs verified copy'] });
  assert.equal(result.status, 'VALIDATING');
  assert.equal(result.repairing, true);
  assert.equal(writes.find(([kind]) => kind === 'run')[1].status, 'VALIDATING');
  assert.equal(writes.find(([kind]) => kind === 'campaign')[1].status, 'GENERATING');
  assert.equal(writes.find(([kind]) => kind === 'event')[1].eventType, 'campaign_contract_repairing');
});

test('late dispatch transport errors cannot overwrite a completed campaign run', async () => {
  const prisma = {
    campaignRun: { async findFirst() { return { status: 'COMPLETED', campaign: { currentPlanVersionId: 'plan-a' } }; } },
  };
  const result = await handleCampaignDispatchError({ prisma, campaignId: 'campaign-a', error: new Error('socket closed') });
  assert.equal(result.ignored, true);
});

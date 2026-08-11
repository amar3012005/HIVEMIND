import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  campaignPlanningEnabled, campaignsV2Enabled, campaignChannelExecutionEnabled,
  requireCampaignPlanning, requireCampaignsV2,
} from '../../src/campaigns/state.js';

// The defect: one org allowlist answered both "may this org PLAN a campaign" and "may this
// org PUBLISH". Production listed exactly ONE org, so every other tenant's HQ runtime died
// 2s into prepare_campaign_contract with runtime_campaign_no_plannable_organic_channel —
// planning_ready was just that allowlist. The runtime itself has no allowlist at all.

const PILOT = '1380251c-f707-4aee-98a4-dd93b63b4a00';
const OTHER = '99999999-0000-0000-0000-000000000000';
const ON = { CAMPAIGNS_V2_ENABLED: 'true', CAMPAIGNS_V2_ORG_IDS: PILOT };

test('planning follows the deployment, not the per-org publish allowlist', () => {
  assert.equal(campaignPlanningEnabled(PILOT, ON), true);
  // The org that used to be locked out of PLANNING is now allowed to plan.
  assert.equal(campaignPlanningEnabled(OTHER, ON), true);
  // And the master switch still turns the whole feature off.
  assert.equal(campaignPlanningEnabled(OTHER, { CAMPAIGNS_V2_ENABLED: 'false', CAMPAIGNS_V2_ORG_IDS: '*' }), false);
  assert.equal(campaignPlanningEnabled(OTHER, {}), false);
});

test('the publish allowlist is UNCHANGED — no new org gained outward authority', () => {
  assert.equal(campaignsV2Enabled(PILOT, ON), true);
  assert.equal(campaignsV2Enabled(OTHER, ON), false, 'a non-pilot org must NOT gain publish rights');
  assert.equal(campaignsV2Enabled(OTHER, { ...ON, CAMPAIGNS_V2_ORG_IDS: '*' }), true, 'explicit * still works');
});

test('channel execution still needs the worker AND an explicit channel opt-in', () => {
  // Widening planning must not make any channel executable on its own.
  assert.equal(campaignChannelExecutionEnabled('x_organic', ON), false);
  assert.equal(campaignChannelExecutionEnabled('x_organic', { ...ON, CAMPAIGNS_V2_WORKER_ENABLED: 'true' }), false,
    'worker alone is not enough — the channel must be listed');
  assert.equal(campaignChannelExecutionEnabled('x_organic', {
    ...ON, CAMPAIGNS_V2_WORKER_ENABLED: 'true', CAMPAIGNS_V2_EXECUTION_CHANNELS: 'x_organic',
  }), true);
});

test('both guards throw a 403 with the same contract', () => {
  const prev = { ...process.env };
  process.env.CAMPAIGNS_V2_ENABLED = 'false';
  try {
    assert.throws(() => requireCampaignPlanning(OTHER), (e) => e.status === 403 && e.code === 'campaigns_v2_disabled');
  } finally { process.env = prev; }
  const prev2 = { ...process.env };
  Object.assign(process.env, { CAMPAIGNS_V2_ENABLED: 'true', CAMPAIGNS_V2_ORG_IDS: PILOT });
  try {
    assert.throws(() => requireCampaignsV2(OTHER), (e) => e.status === 403 && e.code === 'campaigns_v2_disabled');
    requireCampaignPlanning(OTHER); // must NOT throw — this is the unblock
  } finally { process.env = prev2; }
});

test('every outward service operation keeps the strict gate; planning ones do not', async () => {
  const src = await readFile(new URL('../../src/campaigns/service.js', import.meta.url), 'utf8');
  const fnGate = (name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.notEqual(at, -1, `${name} not found`);
    const body = src.slice(at, at + 900);
    if (body.includes('requireCampaignsV2(orgId);')) return 'strict';
    if (body.includes('requireCampaignPlanning(orgId);')) return 'planning';
    return 'none';
  };
  // Anything that can reach the outside world, or authorise reaching it, must stay strict.
  for (const name of ['approveCampaign', 'approveCampaignAction', 'retryCampaignAction',
    'reconcileCampaignAction', 'syncCampaignMetrics', 'controlCampaign']) {
    assert.equal(fnGate(name), 'strict', `${name} must keep the outward publish allowlist`);
  }
  // Drafting, reading and re-planning must follow the runtime.
  for (const name of ['createCampaign', 'listCampaigns', 'getCampaign', 'getCampaignSettings',
    'updateCampaignSettings', 'editCampaignAction', 'regenerateCampaign', 'deleteCampaign']) {
    assert.equal(fnGate(name), 'planning', `${name} must be plannable by any runtime org`);
  }
});

test('planning_ready uses the planning gate while executable stays strict', async () => {
  const src = await readFile(new URL('../../src/campaigns/capabilities.js', import.meta.url), 'utf8');
  assert.equal(src.includes('planning_ready: enabled'), false, 'no planning_ready may use the strict gate');
  assert.ok(src.includes('planning_ready: planningEnabled'));
  // executable / execution_ready must still be built on the strict `enabled`.
  assert.ok(src.includes('executable: enabled &&'));
  assert.ok(src.includes('execution_ready: enabled &&'));
});

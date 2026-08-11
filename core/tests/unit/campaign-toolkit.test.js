import test from 'node:test';
import assert from 'node:assert/strict';

import { Toolkit } from '../../src/agent/toolkit.js';
import {
  CAMPAIGN_TOOL_GROUP,
  executeCampaignTool,
  getCampaignToolCatalog,
  registerCampaignTools,
} from '../../src/agent/connector-toolkits/campaign-tools.js';
import { adaptToDecision, HIGH_TOOLS } from '../../src/agent/chat-progressive-router.js';

test('campaign capability is discoverable but inactive until the Director selects it', () => {
  const toolkit = new Toolkit();
  registerCampaignTools(toolkit, { prisma: {}, userId: 'user-1', orgId: 'org-1', selectedGroups: [CAMPAIGN_TOOL_GROUP] });
  const catalog = toolkit.getToolGroupCatalog().find((group) => group.name === CAMPAIGN_TOOL_GROUP);
  assert.ok(catalog);
  assert.equal(catalog.active, false);
  assert.ok(catalog.tools.some((tool) => tool.name === 'campaign_create' && tool.readOnly === false));
  assert.equal(toolkit.getActiveToolNames().includes('campaign_create'), false);
  toolkit.resetEquippedTools([CAMPAIGN_TOOL_GROUP]);
  assert.equal(toolkit.getActiveToolNames().includes('campaign_create'), true);
});

test('campaign schemas never expose tenant identity or a publish tool', () => {
  const catalog = getCampaignToolCatalog();
  assert.ok(catalog.tools.some((tool) => tool.name === 'campaign_create'));
  assert.equal(catalog.tools.some((tool) => /publish|launch|approve/.test(tool.name)), false);

  const toolkit = new Toolkit();
  registerCampaignTools(toolkit, { prisma: {}, userId: 'server-user', orgId: 'server-org', selectedGroups: [CAMPAIGN_TOOL_GROUP] });
  toolkit.resetEquippedTools([CAMPAIGN_TOOL_GROUP]);
  const create = toolkit.getJsonSchemas().find((schema) => schema.function.name === 'campaign_create');
  assert.ok(create);
  assert.equal('org_id' in create.function.parameters.properties, false);
  assert.equal('user_id' in create.function.parameters.properties, false);
  assert.ok(create.function.parameters.properties.channels.items.enum.includes('google_ads'));
  assert.ok(create.function.parameters.properties.channels.items.enum.includes('meta'));
});

test('campaign list is hard-scoped to the authenticated organization', async () => {
  const oldEnabled = process.env.CAMPAIGNS_V2_ENABLED; const oldOrgs = process.env.CAMPAIGNS_V2_ORG_IDS;
  process.env.CAMPAIGNS_V2_ENABLED = 'true'; process.env.CAMPAIGNS_V2_ORG_IDS = 'org-server';
  let where;
  const prisma = { campaign: { findMany: async (query) => { where = query.where; return []; } } };
  try {
    const result = await executeCampaignTool('campaign_list', {}, {
      prisma, userId: 'user-1', orgId: 'org-server', ctx: {},
    });
    assert.deepEqual(where, { orgId: 'org-server', status: { not: 'CANCELLED' } });
    assert.deepEqual(result, { campaigns: [] });
  } finally {
    if (oldEnabled === undefined) delete process.env.CAMPAIGNS_V2_ENABLED; else process.env.CAMPAIGNS_V2_ENABLED = oldEnabled;
    if (oldOrgs === undefined) delete process.env.CAMPAIGNS_V2_ORG_IDS; else process.env.CAMPAIGNS_V2_ORG_IDS = oldOrgs;
  }
});

test('Campaign Rooms cannot recursively create another Campaign Room', async () => {
  await assert.rejects(
    executeCampaignTool('campaign_create', { goal: 'nested' }, {
      prisma: {}, userId: 'user-1', orgId: 'org-1', ctx: { taskTag: 'CAMPAIGN' },
    }),
    /cannot create or hand off/,
  );
});

test('progressive Director routes campaign requests to the campaign toolkit', () => {
  assert.ok(HIGH_TOOLS.some((tool) => tool.function.name === 'use_campaign'));
  const { decision } = adaptToDecision('use_campaign', {
    intent: 'write', request: 'Run a two-week X awareness campaign', response_language: 'en',
  }, 'Run a two-week X awareness campaign', 'en');
  assert.equal(decision.operation, 'connector_write');
  assert.equal(decision.connector_provider, CAMPAIGN_TOOL_GROUP);
  assert.deepEqual(decision.tool_groups, [CAMPAIGN_TOOL_GROUP]);
});

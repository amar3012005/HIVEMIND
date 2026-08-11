import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __test,
  disconnectCampaignAccount,
  ensureCampaignWebhook,
  getCampaignConnectionState,
  provisionCampaignConnectionState,
  startCampaignAccountConnection,
  syncCampaignConnectionState,
} from '../../src/campaigns/zernio-execution.js';

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
  };
}

function withEnv() {
  const previous = {
    key: process.env.ZERNIO_API_KEY,
    enabled: process.env.CAMPAIGN_INTELLIGENCE_V2_ENABLED,
    base: process.env.ZERNIO_API_BASE_URL,
    callback: process.env.ZERNIO_CONNECT_CALLBACK_URL,
    stateSecret: process.env.ZERNIO_CONNECT_STATE_SECRET,
  };
  process.env.ZERNIO_API_KEY = 'server-only-test-key';
  process.env.CAMPAIGN_INTELLIGENCE_V2_ENABLED = 'true';
  process.env.ZERNIO_API_BASE_URL = 'https://zernio.test/api/v1';
  process.env.ZERNIO_CONNECT_CALLBACK_URL = 'https://api.singulancelabs.com';
  process.env.ZERNIO_CONNECT_STATE_SECRET = 'connect-state-test-secret';
  return () => {
    if (previous.key === undefined) delete process.env.ZERNIO_API_KEY; else process.env.ZERNIO_API_KEY = previous.key;
    if (previous.enabled === undefined) delete process.env.CAMPAIGN_INTELLIGENCE_V2_ENABLED; else process.env.CAMPAIGN_INTELLIGENCE_V2_ENABLED = previous.enabled;
    if (previous.base === undefined) delete process.env.ZERNIO_API_BASE_URL; else process.env.ZERNIO_API_BASE_URL = previous.base;
    if (previous.callback === undefined) delete process.env.ZERNIO_CONNECT_CALLBACK_URL; else process.env.ZERNIO_CONNECT_CALLBACK_URL = previous.callback;
    if (previous.stateSecret === undefined) delete process.env.ZERNIO_CONNECT_STATE_SECRET; else process.env.ZERNIO_CONNECT_STATE_SECRET = previous.stateSecret;
  };
}

test('unprovisioned execution state is safe and contains no provider identifiers', async () => {
  const restore = withEnv();
  try {
    const state = await getCampaignConnectionState({
      prisma: { zernioOrgProfile: { findUnique: async () => null } }, orgId: 'org-a',
    });
    assert.equal(state.status, 'UNPROVISIONED');
    assert.equal(state.configured, true);
    assert.equal(JSON.stringify(state).includes('server-only-test-key'), false);
    assert.equal(JSON.stringify(state).includes('profile_id'), false);
  } finally { restore(); }
});

test('provisioning creates one idempotent profile for the organization and returns sanitized accounts', async () => {
  const restore = withEnv();
  const calls = []; let stored = null;
  const prisma = {
    organization: { findUnique: async ({ where }) => ({ id: where.id, name: 'Acme Legal', slug: 'acme' }) },
    zernioOrgProfile: {
      findUnique: async ({ where }) => stored?.orgId === where.orgId ? stored : null,
      upsert: async ({ create }) => { stored = { ...create, connectedAccounts: [], capabilities: {}, lastSyncedAt: null, lastError: null }; return stored; },
      update: async ({ data }) => { stored = { ...stored, ...data }; return stored; },
    },
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/profiles')) return response(201, { profile: { _id: 'provider-profile-a' } });
    if (url.includes('/accounts?')) return response(200, { accounts: [
      { _id: 'account-secret-a', profileId: 'provider-profile-a', platform: 'twitter', username: 'acme', isActive: true, canPost: true },
      { _id: 'account-other', profileId: 'provider-profile-b', platform: 'linkedin', username: 'other', isActive: true, canPost: true },
    ] });
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    const state = await provisionCampaignConnectionState({ prisma, orgId: 'org-a', userId: 'user-a', fetchImpl });
    assert.equal(calls[0].options.headers['Idempotency-Key'], 'singulance-org-org-a');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer server-only-test-key');
    assert.equal(state.account_count, 1);
    assert.equal(state.channels.find((channel) => channel.id === 'x_organic').execution_ready, true);
    assert.equal(state.connected_accounts[0].username, 'acme');
    assert.equal(JSON.stringify(state).includes('account-secret-a'), false);
    assert.equal(JSON.stringify(state).includes('provider-profile-a'), false);
  } finally { restore(); }
});

test('sync is tenant scoped by the stored provider profile', async () => {
  const restore = withEnv();
  let updated;
  const row = { orgId: 'org-a', zernioProfileId: 'profile-a', connectedAccounts: [], capabilities: {}, status: 'ACTIVE' };
  const prisma = { zernioOrgProfile: {
    findUnique: async ({ where }) => where.orgId === 'org-a' ? row : null,
    update: async ({ data }) => { updated = data; return { ...row, ...data }; },
  } };
  try {
    const state = await syncCampaignConnectionState({
      prisma, orgId: 'org-a',
      fetchImpl: async (url) => {
        assert.match(url, /profileId=profile-a/);
        return response(200, { accounts: [
          { _id: 'a', profileId: 'profile-a', platform: 'linkedin', isActive: true, canPost: true },
          { _id: 'b', profileId: 'profile-b', platform: 'twitter', isActive: true, canPost: true },
        ] });
      },
    });
    assert.equal(updated.connectedAccounts.length, 1);
    assert.equal(state.account_count, 1);
    assert.equal(state.channels[0].id, 'linkedin');
  } finally { restore(); }
});

test('reopening a room reuses a fresh tenant snapshot without another provider request', async () => {
  const restore = withEnv();
  const row = {
    orgId: 'org-a', zernioProfileId: 'profile-a', status: 'ACTIVE', displayName: 'Acme',
    connectedAccounts: [], capabilities: {}, lastSyncedAt: new Date(), lastError: null,
  };
  try {
    const state = await provisionCampaignConnectionState({
      prisma: { zernioOrgProfile: { findUnique: async () => row } },
      orgId: 'org-a', userId: 'user-a',
      fetchImpl: async () => { throw new Error('provider should not be called'); },
    });
    assert.equal(state.status, 'ACTIVE');
  } finally { restore(); }
});

test('paid readiness is not inferred from an ordinary connected social account', () => {
  const accounts = [__test.normalizeAccount({ _id: 'x', platform: 'twitter', isActive: true, canPost: true })];
  const caps = __test.capabilitySnapshot(accounts);
  assert.equal(caps.channels.find((channel) => channel.id === 'x_organic').execution_ready, true);
  assert.equal(caps.channels.some((channel) => channel.id === 'x_ads'), false);
  assert.equal(caps.can_run_ads, false);
});

test('connection flow uses the documented profile-scoped OAuth endpoint and a trusted return origin', async () => {
  const restore = withEnv();
  const previousFrontend = process.env.HIVEMIND_FRONTEND_URL;
  process.env.HIVEMIND_FRONTEND_URL = 'https://next.singulancelabs.com';
  const row = { orgId: 'org-a', zernioProfileId: 'profile-a', connectedAccounts: [] };
  try {
    const result = await startCampaignAccountConnection({
      prisma: { zernioOrgProfile: { findUnique: async () => row } },
      orgId: 'org-a', userId: 'user-a', platform: 'twitter',
      returnPath: '/hivemind/app/employees/rooms/room-a?view=campaign',
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        assert.equal(parsed.pathname, '/api/v1/connect/twitter');
        assert.equal(parsed.searchParams.get('profileId'), 'profile-a');
        const redirect = new URL(parsed.searchParams.get('redirect_url'));
        assert.equal(redirect.origin, 'https://api.singulancelabs.com');
        assert.equal(redirect.pathname, '/api/campaigns/connections/callback');
        const finalRedirect = __test.verifyConnectState(redirect.searchParams.get('connection_state'));
        assert.equal(finalRedirect.platform, 'twitter');
        assert.equal(finalRedirect.path, '/hivemind/app/employees/rooms/room-a?view=campaign');
        return response(200, { authUrl: 'https://x.example/authorize' });
      },
    });
    assert.equal(result.authorization_url, 'https://x.example/authorize');
  } finally {
    if (previousFrontend === undefined) delete process.env.HIVEMIND_FRONTEND_URL; else process.env.HIVEMIND_FRONTEND_URL = previousFrontend;
    restore();
  }
});

test('signed provider callback strips provider identifiers before returning to the browser', async () => {
  const restore = withEnv();
  const previousFrontend = process.env.HIVEMIND_FRONTEND_URL;
  process.env.HIVEMIND_FRONTEND_URL = 'https://next.singulancelabs.com';
  try {
    const callback = new URL(__test.campaignReturnUrl({ platform: 'linkedin', returnPath: '/hivemind/app/employees/rooms/room-a' }));
    callback.searchParams.set('connected', 'linkedin');
    callback.searchParams.set('profileId', 'provider-profile-secret');
    callback.searchParams.set('accountId', 'provider-account-secret');
    const result = new URL((await import('../../src/campaigns/zernio-execution.js')).completeCampaignConnectionRedirect(callback.toString()));
    assert.equal(result.origin, 'https://next.singulancelabs.com');
    assert.equal(result.pathname, '/hivemind/app/employees/rooms/room-a');
    assert.equal(result.searchParams.get('campaign_connection'), 'linkedin');
    assert.equal(result.searchParams.has('profileId'), false);
    assert.equal(result.searchParams.has('accountId'), false);
    assert.equal(result.toString().includes('provider-profile-secret'), false);
  } finally {
    if (previousFrontend === undefined) delete process.env.HIVEMIND_FRONTEND_URL; else process.env.HIVEMIND_FRONTEND_URL = previousFrontend;
    restore();
  }
});

test('X Ads connection requires and sends the tenant-owned posting account', async () => {
  const restore = withEnv();
  const account = __test.normalizeAccount({ _id: 'twitter-a', profileId: 'profile-a', platform: 'twitter', isActive: true }, 'org-a');
  const row = { orgId: 'org-a', zernioProfileId: 'profile-a', connectedAccounts: [account] };
  try {
    const result = await startCampaignAccountConnection({
      prisma: { zernioOrgProfile: { findUnique: async () => row } },
      orgId: 'org-a', userId: 'user-a', platform: 'twitter', connectionKind: 'ads',
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        assert.equal(parsed.pathname, '/api/v1/connect/twitter/ads');
        assert.equal(parsed.searchParams.get('accountId'), 'twitter-a');
        return response(200, { authUrl: 'https://x.example/ads-authorize' });
      },
    });
    assert.equal(result.connection_kind, 'ads');
  } finally { restore(); }
});

test('Google Ads uses the paid connection platform without passing organic validation', async () => {
  const restore = withEnv();
  const row = { orgId: 'org-a', zernioProfileId: 'profile-a', connectedAccounts: [] };
  try {
    const result = await startCampaignAccountConnection({
      prisma: { zernioOrgProfile: { findUnique: async () => row } },
      orgId: 'org-a', userId: 'user-a', platform: 'googleads', connectionKind: 'ads',
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        assert.equal(parsed.pathname, '/api/v1/connect/googleads/ads');
        return response(200, { authUrl: 'https://google.example/ads-authorize' });
      },
    });
    assert.equal(result.platform, 'googleads');
    assert.equal(result.connection_kind, 'ads');
  } finally { restore(); }
});

test('disconnect resolves only a tenant-safe account reference before provider deletion', async () => {
  const restore = withEnv();
  const account = __test.normalizeAccount({ _id: 'twitter-a', platform: 'twitter', isActive: true }, 'org-a');
  let row = { orgId: 'org-a', zernioProfileId: 'profile-a', connectedAccounts: [account], capabilities: {}, status: 'ACTIVE' };
  const calls = [];
  const prisma = { zernioOrgProfile: {
    findUnique: async () => row,
    update: async ({ data }) => { row = { ...row, ...data }; return row; },
  } };
  try {
    await disconnectCampaignAccount({
      prisma, orgId: 'org-a', accountRef: account.account_ref,
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (options.method === 'DELETE') return response(200, { message: 'ok' });
        return response(200, { accounts: [] });
      },
    });
    assert.equal(new URL(calls[0].url).pathname, '/api/v1/accounts/twitter-a');
    assert.equal(calls[0].options.method, 'DELETE');
  } finally { restore(); }
});

test('sync auto-selects exactly one usable advertiser account but never guesses among several', async () => {
  const restore = withEnv();
  let stored = { orgId: 'org-a', zernioProfileId: 'profile-a', connectedAccounts: [], capabilities: {}, selectedAdAccounts: {}, status: 'ACTIVE' };
  const prisma = { zernioOrgProfile: {
    async findUnique() { return stored; },
    async update({ data }) { stored = { ...stored, ...data }; return stored; },
  } };
  try {
    const state = await syncCampaignConnectionState({
      prisma, orgId: 'org-a',
      fetchImpl: async (url) => {
        if (url.includes('/ads/accounts?')) return response(200, { accounts: [{ id: 'advertiser-a', name: 'Acme Ads', currency: 'EUR', selectable: true }] });
        if (url.includes('/accounts?')) return response(200, { accounts: [{ _id: 'xads-a', profileId: 'profile-a', platform: 'xads', isActive: true }] });
        throw new Error(`Unexpected request ${url}`);
      },
    });
    const xAds = state.channels.find((channel) => channel.id === 'x_ads');
    assert.equal(xAds.execution_ready, true);
    assert.equal(xAds.selected_ad_account.name, 'Acme Ads');
    assert.equal(state.selected_ad_accounts.x_ads.name, 'Acme Ads');
    assert.equal(JSON.stringify(state).includes('advertiser-a'), false);
    assert.equal(JSON.stringify(state).includes('xads-a'), false);
  } finally { restore(); }
});

test('sync requires an explicit choice when several advertiser accounts are usable', async () => {
  const restore = withEnv();
  let stored = { orgId: 'org-a', zernioProfileId: 'profile-a', connectedAccounts: [], capabilities: {}, selectedAdAccounts: {}, status: 'ACTIVE' };
  const prisma = { zernioOrgProfile: {
    async findUnique() { return stored; },
    async update({ data }) { stored = { ...stored, ...data }; return stored; },
  } };
  try {
    const state = await syncCampaignConnectionState({
      prisma, orgId: 'org-a',
      fetchImpl: async (url) => {
        if (url.includes('/ads/accounts?')) return response(200, { accounts: [
          { id: 'advertiser-a', name: 'Europe', currency: 'EUR', selectable: true },
          { id: 'advertiser-b', name: 'United Kingdom', currency: 'GBP', selectable: true },
        ] });
        if (url.includes('/accounts?')) return response(200, { accounts: [{ _id: 'xads-a', profileId: 'profile-a', platform: 'xads', isActive: true }] });
        throw new Error(`Unexpected request ${url}`);
      },
    });
    const xAds = state.channels.find((channel) => channel.id === 'x_ads');
    assert.equal(xAds.execution_ready, false);
    assert.equal(xAds.reason, 'select_ad_account');
    assert.equal(xAds.ad_accounts.length, 2);
    assert.equal(state.selected_ad_accounts.x_ads, undefined);
    assert.equal(JSON.stringify(state).includes('advertiser-a'), false);
    assert.equal(JSON.stringify(state).includes('advertiser-b'), false);
  } finally { restore(); }
});

test('webhook registration uses the official settings endpoint and configured event set', async () => {
  const restore = withEnv();
  const previous = {
    secret: process.env.ZERNIO_WEBHOOK_SECRET,
    publicUrl: process.env.ZERNIO_WEBHOOK_PUBLIC_URL,
  };
  process.env.ZERNIO_WEBHOOK_SECRET = 'webhook-test-secret';
  process.env.ZERNIO_WEBHOOK_PUBLIC_URL = 'https://api.singulancelabs.com';
  const calls = [];
  try {
    const result = await ensureCampaignWebhook({ fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (!options.method || options.method === 'GET') return response(200, { webhooks: [] });
      return response(201, { webhook: { _id: 'webhook-a' } });
    } });
    assert.deepEqual(result, { configured: true, created: true });
    assert.equal(new URL(calls[0].url).pathname, '/api/v1/webhooks/settings');
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[1].options.body.includes('https://api.singulancelabs.com/api/campaigns/webhooks/zernio'), true);
    assert.equal(calls[1].options.body.includes('post.published'), true);
    assert.equal(calls[1].options.body.includes('comment.received'), true);
    assert.equal(calls[1].options.body.includes('ad.status_changed'), true);
  } finally {
    if (previous.secret === undefined) delete process.env.ZERNIO_WEBHOOK_SECRET; else process.env.ZERNIO_WEBHOOK_SECRET = previous.secret;
    if (previous.publicUrl === undefined) delete process.env.ZERNIO_WEBHOOK_PUBLIC_URL; else process.env.ZERNIO_WEBHOOK_PUBLIC_URL = previous.publicUrl;
    restore();
  }
});

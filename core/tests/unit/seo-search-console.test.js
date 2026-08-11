import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SeoSearchConsoleService, comparisonPeriods, compileSearchConsoleEvidence,
} from '../../src/capabilities/seo-search-console.js';
import { DEFAULT_SERVICES, getOAuthConfig } from '../../src/connectors/providers/gmail/oauth.js';
import { ConnectorStore, decryptToken, encryptToken } from '../../src/connectors/framework/connector-store.js';

test('Search Console consent is explicit and excluded from default Workspace scopes', () => {
  assert.equal(DEFAULT_SERVICES.includes('search-console'), false);
  assert.equal(getOAuthConfig().scopes.includes('https://www.googleapis.com/auth/webmasters.readonly'), false);
  assert.equal(getOAuthConfig({ services: ['search-console'] }).scopes.includes('https://www.googleapis.com/auth/webmasters.readonly'), true);
});

test('incremental Google consent preserves an existing refresh token', async () => {
  let update;
  const existing = {
    id: 'integration-1',
    refreshTokenEncrypted: encryptToken('durable-refresh-token'),
    connectorMetadata: {},
  };
  const store = new ConnectorStore({
    platformIntegration: {
      findUnique: async () => existing,
      update: async (args) => { update = args; return args.data; },
    },
  });

  await store.upsertConnector({
    userId: 'user-1', provider: 'google-search-console', accountRef: 'owner@example.com',
    accessToken: 'new-access-token', refreshToken: null,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });

  assert.equal(decryptToken(update.data.refreshTokenEncrypted), 'durable-refresh-token');
});

test('comparison periods use two adjacent finalized 28-day windows', () => {
  assert.deepEqual(comparisonPeriods(new Date('2026-07-28T12:00:00Z')), {
    current: { start_date: '2026-06-28', end_date: '2026-07-25' },
    previous: { start_date: '2026-05-31', end_date: '2026-06-27' },
  });
});

test('Search Console evidence identifies query and page opportunities without credentials', () => {
  const evidence = compileSearchConsoleEvidence({
    siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner',
    periods: comparisonPeriods(new Date('2026-07-28T12:00:00Z')),
    datasets: {
      currentTotals: { rows: [{ clicks: 90, impressions: 5000, ctr: 0.018, position: 9 }] },
      previousTotals: { rows: [{ clicks: 100, impressions: 4000, ctr: 0.025, position: 8 }] },
      queries: { rows: [
        { keys: ['ai operating system'], clicks: 5, impressions: 500, ctr: 0.01, position: 8 },
        { keys: ['new ai workflow'], clicks: 1, impressions: 80, ctr: 0.0125, position: 22 },
      ] },
      previousQueries: { rows: [
        { keys: ['ai operating system'], clicks: 8, impressions: 300, ctr: 0.026, position: 10 },
        { keys: ['new ai workflow'], clicks: 0, impressions: 20, ctr: 0, position: 40 },
      ] },
      pages: { rows: [{ keys: ['https://example.com/product'], clicks: 20, impressions: 1000, ctr: 0.02, position: 8 }] },
      previousPages: { rows: [{ keys: ['https://example.com/product'], clicks: 40, impressions: 1200, ctr: 0.033, position: 7 }] },
      queryPages: { rows: [{ keys: ['ai operating system', 'https://example.com/product'], clicks: 10, impressions: 500, ctr: 0.02, position: 8 }] },
      daily: { rows: [{ keys: ['2026-07-25'], clicks: 4, impressions: 200, ctr: 0.02, position: 9 }] },
    },
    fetchedAt: '2026-07-28T12:00:00Z',
  });
  assert.equal(evidence.status, 'connected');
  assert.ok(evidence.opportunities.some((item) => item.type === 'striking_distance_query'));
  assert.ok(evidence.opportunities.some((item) => item.type === 'high_impression_low_ctr'));
  assert.ok(evidence.opportunities.some((item) => item.type === 'emerging_query'));
  assert.ok(evidence.opportunities.some((item) => item.type === 'declining_page'));
  assert.equal(JSON.stringify(evidence).includes('access_token'), false);
});

test('property selection requires active org admin and a property returned by Google', async () => {
  const writes = [];
  const prisma = {
    userOrganization: { findUnique: async () => ({ isActive: true, role: 'admin', roles: ['admin'] }) },
    platformIntegration: { findFirst: async () => ({ id: 'integration-1', platformUserId: 'owner@example.com', oauthScopes: [] }) },
    seoSearchConsoleProperty: { upsert: async (args) => { writes.push(args); return { ...args.create, id: 'property-1' }; } },
  };
  const service = new SeoSearchConsoleService({
    prisma, connectorStoreFactory: () => ({ getAccessToken: async () => 'secret-token' }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ siteEntry: [
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
    ] }) }),
  });
  const selected = await service.selectProperty({ orgId: 'org-1', userId: 'user-1', siteUrl: 'sc-domain:example.com' });
  assert.equal(selected.siteUrl, 'sc-domain:example.com');
  assert.equal(writes[0].create.orgId, 'org-1');
  await assert.rejects(() => service.selectProperty({ orgId: 'org-1', userId: 'user-1', siteUrl: 'https://attacker.example/' }), /returned by Google/);
});

test('collection uses the org-bound integration and persists a tenant snapshot', async () => {
  const requests = [];
  let snapshot;
  const property = {
    id: 'property-1', orgId: 'org-1', connectedByUserId: 'owner-1', integrationId: 'integration-1',
    siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner',
  };
  const prisma = {
    seoSearchConsoleProperty: { findUnique: async () => property },
    userOrganization: { findUnique: async () => ({ isActive: true, role: 'owner' }) },
    platformIntegration: { findFirst: async () => ({ id: 'integration-1', userId: 'owner-1', oauthScopes: [] }) },
    seoSearchConsoleSnapshot: { upsert: async (args) => { snapshot = args; return args.create; } },
  };
  const service = new SeoSearchConsoleService({
    prisma, now: () => new Date('2026-07-28T12:00:00Z'),
    connectorStoreFactory: () => ({ getAccessToken: async (userId, provider) => {
      assert.equal(userId, 'owner-1'); assert.equal(provider, 'google-search-console'); return 'secret-token';
    } }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ rows: [] }) };
    },
  });
  const evidence = await service.collect({ orgId: 'org-1', userId: 'member-2' });
  assert.equal(evidence.status, 'connected');
  assert.equal(requests.length, 8);
  assert.ok(requests.every((request) => request.options.headers.authorization === 'Bearer secret-token'));
  assert.equal(snapshot.create.orgId, 'org-1');
  assert.equal(snapshot.create.propertyId, 'property-1');
  assert.equal(JSON.stringify(snapshot).includes('secret-token'), false);
});

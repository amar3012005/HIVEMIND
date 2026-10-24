import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.COMPOSIO_API_KEY = 'fixture-only';
const account = (id, toolkit = 'gmail') => ({ id, status: 'ACTIVE', toolkit: { slug: toolkit } });

async function fixture(run) {
  const original = globalThis.fetch;
  const catalogs = new Map(); const deleted = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (options.method === 'DELETE') {
      deleted.push(decodeURIComponent(parsed.pathname.split('/').pop()));
      return new Response('{}');
    }
    if (parsed.pathname.endsWith('/connected_accounts')) {
      return new Response(JSON.stringify({ items: catalogs.get(parsed.searchParams.get('user_ids')) || [] }));
    }
    throw new Error(`unexpected fixture call ${parsed.pathname}`);
  };
  try {
    const service = await import(`../../src/connectors/composio/composio-service.js?org-authority=${Math.random()}`);
    await run({ service, catalogs, deleted });
  } finally { globalThis.fetch = original; }
}

test('a member cannot disconnect the organization-wide toolkit account', () => fixture(async ({ service, catalogs, deleted }) => {
  catalogs.set('org-1', [account('shared-gmail')]);
  await assert.rejects(service.disconnectToolkit('org-1', 'gmail', { userId: 'member' }), (error) => error.status === 403);
  await assert.rejects(service.disconnectToolkit('org-1', 'gmail'), (error) => error.status === 403);
  assert.deepEqual(deleted, []);
}));

test('a member removes only their own account when both exist', () => fixture(async ({ service, catalogs, deleted }) => {
  catalogs.set('org-1', [account('shared-gmail')]);
  catalogs.set('hivemind:member', [account('member-gmail')]);
  assert.equal(await service.disconnectToolkit('org-1', 'gmail', { userId: 'member' }), 1);
  assert.deepEqual(deleted, ['member-gmail']);
}));

test('an owner or admin can disconnect the organization-wide account', () => fixture(async ({ service, catalogs, deleted }) => {
  catalogs.set('org-1', [account('shared-gmail')]);
  assert.equal(await service.disconnectToolkit('org-1', 'gmail', { userId: 'admin', allowOrganizationAccount: true }), 1);
  assert.deepEqual(deleted, ['shared-gmail']);
}));

test('organization subjects are identified exactly', () => fixture(async ({ service }) => {
  assert.equal(service.isOrganizationSubject('org-1', 'org-1'), true);
  assert.equal(service.isOrganizationSubject('org-1', 'hivemind:user'), false);
  assert.equal(service.isOrganizationSubject('', ''), false);
}));

test('Control Plane connect and disconnect routes gate organization-wide accounts on owner/admin', () => {
  const server = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
  const connect = server.slice(server.indexOf('const composioConnectMatch'), server.indexOf('const composioApiKeyMatch'));
  const apiKey = server.slice(server.indexOf('const composioApiKeyMatch'), server.indexOf('const composioDisconnectMatch'));
  const disconnect = server.slice(server.indexOf('const composioDisconnectMatch'), server.indexOf("pathname === '/v1/connectors/composio/toolkits'"));
  for (const route of [connect, apiKey]) {
    assert.ok(route.indexOf('sessionManagesOrganization(current.session, orgId)') > 0);
    assert.ok(route.indexOf('sessionManagesOrganization') < route.indexOf('composioService.create'));
  }
  assert.match(disconnect, /allowOrganizationAccount: await sessionManagesOrganization\(current\.session, orgId\)/);
  const legacy = server.slice(server.indexOf('const connectorDisconnectMatch'));
  assert.match(legacy.slice(0, 1500), /allowOrganizationAccount: await sessionManagesOrganization\(current\.session, orgId\)/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.COMPOSIO_API_KEY = 'fixture-only';
const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/connectors-parity.json', import.meta.url), 'utf8'));
const service = await import(`../../src/connectors/composio/composio-service.js?parity=${Math.random()}`);
const { orgId, userId } = fixture;
const subjectOf = (row) => (row.subject === 'personal' ? `hivemind:${userId}` : orgId);
const accountsOf = (rows) => rows.map((row) => ({ ...row, subject: subjectOf(row) }));
const canonical = (row) => ({ toolkit: row.toolkit, status: row.status, origin: row.origin ?? null, accountId: row.accountId ?? null });

test('Core rows match the shared inventory fixture (same rows as the Runtime apps listing)', () => {
  const rows = [...service.toolkitConnectionRows(orgId, accountsOf(fixture.accounts)).values()]
    .map(canonical).sort((a, b) => a.toolkit.localeCompare(b.toolkit));
  assert.deepEqual(rows, fixture.expectedRows);
});

test('the Connectors listing shows one row per catalog toolkit: connected, reconnect or available', () => {
  const rows = service.toolkitConnectionRows(orgId, accountsOf(fixture.accounts));
  const listing = service.withToolkitConnections(fixture.catalog.map((slug) => ({ slug })), rows)
    .map((toolkit) => canonical({ toolkit: toolkit.slug, status: toolkit.connection_status, origin: toolkit.connection_origin, accountId: toolkit.connected_account_id }))
    .sort((a, b) => a.toolkit.localeCompare(b.toolkit));
  assert.deepEqual(listing, fixture.expectedListing);
  const byFlag = service.withToolkitConnections(fixture.catalog.map((slug) => ({ slug })), rows);
  assert.equal(byFlag.find((toolkit) => toolkit.slug === 'github').connected, false, 'reconnect is not connected');
  assert.equal(byFlag.find((toolkit) => toolkit.slug === 'gmail').connected, true);
});

for (const rule of fixture.rules) {
  test(`rule: ${rule.name}`, () => {
    const rows = service.toolkitConnectionRows(orgId, accountsOf(rule.accounts));
    const got = [...rows.values()].map(canonical);
    assert.deepEqual(got, rule.expected === null ? [] : [rule.expected]);
  });
}

test('the Connectors listing route applies the rule instead of treating any ACTIVE account as connected', () => {
  const server = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("pathname === '/v1/connectors/composio/toolkits' &&"), server.indexOf("// GET /v1/connectors/composio/toolkits/:slug/tools"));
  assert.match(route, /composioService\.toolkitConnectionRows\(orgId, accounts\)/);
  assert.match(route, /composioService\.withToolkitConnections\(page\.items, rows\)/);
  assert.doesNotMatch(route, /accounts\.filter\(\(a\) => a\.status === 'ACTIVE'\)/);
});

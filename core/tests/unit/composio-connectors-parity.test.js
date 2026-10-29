import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { overlayToolkitRows } from '../../src/connectors/connected-app-overlay.js';

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

test('the /v1/connectors list carries the same status, origin and chosen account per toolkit', () => {
  const rows = service.toolkitConnectionRows(orgId, accountsOf(fixture.accounts));
  const list = overlayToolkitRows([{ provider: 'gmail', label: 'Gmail', status: 'available' }, { provider: 'github', label: 'GitHub', status: 'available' },
    { provider: 'notion', label: 'Notion', status: 'available' }], rows);
  const view = (provider) => list.find((row) => row.provider === provider);
  assert.deepEqual([view('gmail').status, view('gmail').origin, view('gmail').account_ref, view('gmail').label], ['connected', 'personal', 'ca_p_gmail', 'Gmail']);
  assert.deepEqual([view('github').status, view('github').is_active], ['needs_reauth', false]);
  assert.equal(view('notion').status, 'needs_reauth', 'the organization notion account is expired');
  const expected = new Map(fixture.expectedRows.map((row) => [row.toolkit, row]));
  for (const row of list.filter((entry) => expected.has(entry.provider))) {
    const want = expected.get(row.provider);
    assert.equal(row.status === 'connected' ? 'connected' : 'reconnect', want.status);
    assert.equal(row.account_ref ?? null, want.accountId);
  }
  assert.equal(list.length, fixture.expectedRows.length + 0, 'one row per toolkit, no duplicates');
});

test('the /v1/connectors route builds its list from the shared rows', () => {
  const server = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("pathname === '/v1/connectors' &&"), server.indexOf('const whatsappStatus'));
  assert.match(route, /overlayToolkitRows\(result, toolkitRows\)/);
  assert.doesNotMatch(route, /rows\.find\(\(r\) => r\.status === 'ACTIVE'\)/);
});

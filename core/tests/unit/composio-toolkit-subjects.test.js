import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.COMPOSIO_API_KEY = 'fixture-only';
process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify({ gmail: 'ac_gmail', hubspot: 'ac_hubspot' });
const ORG = 'org-1'; const USER = 'user-1';
const row = (id, toolkit, status, subject, updatedAt) => ({ id, toolkit, status, subject, updatedAt });
const T = (day) => `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`;

const service = await import(`../../src/connectors/composio/composio-service.js?subjects=${Math.random()}`);

test('personal ACTIVE account wins; expired never wins; both active picks the newest, tie to personal', () => {
  const chosen = service.chooseToolkitSubjects(ORG, [
    row('p-gmail', 'gmail', 'ACTIVE', `hivemind:${USER}`, T(10)), row('o-gmail', 'gmail', 'ACTIVE', ORG, T(5)),
    row('o-cal', 'googlecalendar', 'ACTIVE', ORG, T(1)), row('p-cal', 'googlecalendar', 'EXPIRED', `hivemind:${USER}`, T(20)),
    row('p-gh', 'github', 'EXPIRED', `hivemind:${USER}`, T(9)),
    row('p-li', 'linkedin', 'ACTIVE', `hivemind:${USER}`, T(3)), row('o-li', 'linkedin', 'ACTIVE', ORG, T(8)),
    row('p-tie', 'notion', 'ACTIVE', `${ORG}:${USER}`, T(4)), row('o-tie', 'notion', 'ACTIVE', ORG, T(4)),
    row('x', 'hunter', 'EXPIRED', ORG, T(1)), row('y', 'hunter', 'EXPIRED', ORG, T(2)),
    row('i', 'asana', 'INITIATED', `hivemind:${USER}`, T(2)),
  ]);
  assert.deepEqual([chosen.get('gmail').subject, chosen.get('gmail').origin], [`hivemind:${USER}`, 'personal']);
  assert.deepEqual([chosen.get('googlecalendar').subject, chosen.get('googlecalendar').accountId], [ORG, 'o-cal']);
  assert.equal(chosen.get('github').state, 'reconnect');
  assert.equal(chosen.get('github').subject, undefined);
  assert.equal(chosen.get('linkedin').subject, ORG);
  assert.equal(chosen.get('notion').subject, `${ORG}:${USER}`);
  assert.equal(chosen.get('hunter').state, 'reconnect');
  assert.equal(chosen.has('asana'), false);
  assert.equal([...chosen.keys()].filter((k) => k === 'gmail').length, 1);
});

test('new connections go to the personal subject regardless of COMPOSIO_GOVERNED_CONNECTION_SCOPE', () => {
  const saved = [process.env.COMPOSIO_GOVERNED_CONNECTION_SCOPE, process.env.COMPOSIO_ORG_SHARED_TOOLKITS];
  try {
    process.env.COMPOSIO_GOVERNED_CONNECTION_SCOPE = 'org';
    delete process.env.COMPOSIO_ORG_SHARED_TOOLKITS;
    assert.equal(service.composioConnectSubject(ORG, 'gmail', { userId: USER }), `hivemind:${USER}`);
    assert.equal(service.composioConnectSubject(ORG, 'gmail', {}), ORG);
    process.env.COMPOSIO_ORG_SHARED_TOOLKITS = 'HubSpot, salesforce';
    assert.equal(service.composioConnectSubject(ORG, 'hubspot', { userId: USER }), ORG);
    assert.equal(service.composioConnectSubject(ORG, 'gmail', { userId: USER }), `hivemind:${USER}`);
  } finally {
    for (const [i, name] of ['COMPOSIO_GOVERNED_CONNECTION_SCOPE', 'COMPOSIO_ORG_SHARED_TOOLKITS'].entries()) {
      if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i];
    }
  }
});

async function withFetch(handler, run) {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: new URL(url), method: options.method, body });
    return new Response(JSON.stringify(handler(new URL(url), body)), { status: 200 });
  };
  try { await run(calls); } finally { globalThis.fetch = original; }
}

test('connect link and API-key connection are created on the personal subject (both connect endpoints share them)', async () => {
  process.env.COMPOSIO_GOVERNED_CONNECTION_SCOPE = 'org';
  try {
    await withFetch((url) => (url.pathname.endsWith('/link') ? { redirect_url: 'https://x', connected_account_id: 'ca', expires_at: 'e' } : { id: 'ca2', status: 'ACTIVE' }), async (calls) => {
      await service.createConnectLink('gmail', ORG, { userId: USER });
      await service.createApiKeyConnection(ORG, 'hubspot', 'k', { userId: USER }).catch(() => {});
      const link = calls.find((c) => c.url.pathname.endsWith('/connected_accounts/link'));
      assert.equal(link.body.user_id, `hivemind:${USER}`);
      const created = calls.find((c) => c.method === 'POST' && c.url.pathname === '/api/v3/connected_accounts');
      assert.ok(created);
      assert.equal(created.body.connection.user_id, `hivemind:${USER}`);
    });
  } finally { delete process.env.COMPOSIO_GOVERNED_CONNECTION_SCOPE; }
});

test('both connect endpoints and callers use the shared subject rule', () => {
  const server = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
  const connect = server.slice(server.indexOf('const composioConnectMatch'), server.indexOf('const composioDisconnectMatch'));
  assert.equal((connect.match(/composioConnectSubject\(orgId, toolkitSlug/g) || []).length, 2);
  assert.doesNotMatch(connect, /composioConnectionSubject/);
  for (const file of ['agent/compound-orchestrator.js', 'agent/durable-composio-agent.js']) {
    const source = fs.readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
    for (const call of source.split('createConnectLink(').slice(1).filter((part) => part.startsWith('toolkit') || part.startsWith('composioToolkit'))) {
      assert.match(call.slice(0, 220), /userId: ctx\.userId/);
    }
  }
});

test('router sessions and per-user execution use the chosen subject per toolkit', async () => {
  await withFetch((url, body) => {
    if (url.pathname === '/api/v3.1/connected_accounts') {
      const subject = url.searchParams.get('user_ids');
      if (subject === `hivemind:${USER}`) return { items: [
        { id: 'p-gmail', status: 'ACTIVE', toolkit: { slug: 'gmail' }, updated_at: T(3) },
        { id: 'p-gh', status: 'EXPIRED', toolkit: { slug: 'github' }, updated_at: T(3) }] };
      if (subject === ORG) return { items: [
        { id: 'o-gh', status: 'ACTIVE', toolkit: { slug: 'github' }, updated_at: T(2) },
        { id: 'o-gmail', status: 'ACTIVE', toolkit: { slug: 'gmail' }, updated_at: T(9) }] };
      return { items: [] };
    }
    if (url.pathname === '/api/v3/tool_router/session') return { session_id: 'trs_1' };
    return { successful: true, data: {} };
  }, async (calls) => {
    // gmail: both active, org newer -> organization account; github: only org active.
    const gmail = await service.getToolRouterSession(ORG, ['gmail'], { userId: USER, includeCustomToolkit: false });
    assert.deepEqual([gmail.subject, gmail.connectedAccounts], [ORG, { gmail: 'o-gmail' }]);
    const github = await service.getToolRouterSession(ORG, ['github'], { userId: USER, includeCustomToolkit: false });
    assert.equal(github.subject, ORG);
    await service.executeToolForUser(ORG, USER, 'GMAIL_FETCH_EMAILS', {});
    const executed = calls.filter((c) => c.url.pathname.includes('/tools/execute/')).map((c) => c.body.user_id);
    assert.deepEqual(executed, [ORG]);
  });
});

test('a toolkit with no account connects its session on the personal subject, ignoring the org env default', async () => {
  process.env.COMPOSIO_GOVERNED_CONNECTION_SCOPE = 'org';
  try {
    await withFetch((url) => (url.pathname === '/api/v3/tool_router/session' ? { session_id: 'trs_2' } : { items: [] }), async (calls) => {
      const session = await service.getToolRouterSession(ORG, ['linkedin'], { userId: USER, allowDisconnected: true, manageConnections: true, includeCustomToolkit: false });
      assert.equal(session.subject, `hivemind:${USER}`);
      assert.equal(calls.find((c) => c.url.pathname === '/api/v3/tool_router/session').body.user_id, `hivemind:${USER}`);
    });
  } finally { delete process.env.COMPOSIO_GOVERNED_CONNECTION_SCOPE; }
});

test('connected-apps tasks endpoint resolves per toolkit, lists reconnect, and stays read-only', () => {
  const server = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
  const start = server.indexOf("pathname === '/v1/service/connected-apps/tasks'");
  const endpoint = server.slice(server.lastIndexOf('// POST /v1/service/connected-apps/tasks', start), start + 14000);
  assert.match(endpoint, /chooseToolkitSubjects\(principal\.orgId, accounts\)/);
  assert.match(endpoint, /reconnectToolkits/);
  assert.match(endpoint, /WRITES STAY OUT OF HERE/);
  assert.doesNotMatch(endpoint, /action === 'execute_write'|'execute_write'/);
});

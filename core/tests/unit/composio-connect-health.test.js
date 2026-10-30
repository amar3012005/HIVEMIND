// Connect readiness: an app without a usable auth path is refused before Composio is called, Composio failures map to
// actionable messages, expired connections are replaced once, and the daily health run reports broken auth configs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyConnectError, classifyToolkitConnect, ComposioConnectError, CONNECT_UNAVAILABLE_MESSAGE } from '../../src/connectors/composio/connect-readiness.js';
import { assessConnectHealth, runComposioConnectHealth } from '../../src/connectors/composio/connect-health.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const TWITTER = { slug: 'twitter', auth_schemes: ['OAUTH2'], composio_managed_auth_schemes: [], no_auth: false };
const GMAIL = { slug: 'gmail', auth_schemes: ['OAUTH2'], composio_managed_auth_schemes: ['OAUTH2'], no_auth: false };

async function withComposio(routes, run) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.COMPOSIO_API_KEY;
  const originalConfigs = process.env.COMPOSIO_AUTH_CONFIGS;
  process.env.COMPOSIO_API_KEY = 'test-key';
  delete process.env.COMPOSIO_AUTH_CONFIGS;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace('https://backend.composio.dev', '');
    const method = options.method || 'GET';
    calls.push({ method, path, body: options.body ? JSON.parse(options.body) : null });
    for (const [pattern, handler] of routes) {
      if (pattern.test(`${method} ${path}`)) return handler({ method, path, body: options.body ? JSON.parse(options.body) : null, calls });
    }
    return json({ error: { message: 'unrouted' } }, 500);
  };
  try {
    const service = await import(`../../src/connectors/composio/composio-service.js?test=${Date.now()}-${Math.random()}`);
    await run(service, calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.COMPOSIO_API_KEY; else process.env.COMPOSIO_API_KEY = originalKey;
    if (originalConfigs === undefined) delete process.env.COMPOSIO_AUTH_CONFIGS; else process.env.COMPOSIO_AUTH_CONFIGS = originalConfigs;
  }
}

test('toolkit connect rule: managed OAuth2, API key and custom-app apps', () => {
  assert.deepEqual(classifyToolkitConnect({ authSchemes: ['OAUTH2'], composioManagedAuthSchemes: ['OAUTH2'] }), { connectable: true, mode: 'managed_oauth2', reason: null });
  assert.equal(classifyToolkitConnect({ authSchemes: ['API_KEY'], composioManagedAuthSchemes: [] }).mode, 'api_key');
  assert.deepEqual(classifyToolkitConnect({ authSchemes: ['OAUTH2'], composioManagedAuthSchemes: [] }), { connectable: false, mode: 'blocked', reason: 'needs_custom_oauth_app' });
  assert.equal(classifyToolkitConnect({ authSchemes: ['DCR_OAUTH'] }).reason, 'unsupported_auth_scheme');
  assert.equal(classifyToolkitConnect({ authSchemes: ['OAUTH2'], composioManagedAuthSchemes: [] }, { authConfigId: 'ac_custom' }).mode, 'configured');
  assert.equal(classifyToolkitConnect({ noAuth: true }).mode, 'no_auth');
});

test('Composio errors map to actionable messages without upstream text', () => {
  const fromStatus = (status, message = 'Composio POST /x: secret detail ac_123') => classifyConnectError(Object.assign(new Error(message), { status }));
  assert.equal(fromStatus(400).code, 'connect_unavailable');
  assert.equal(fromStatus(400).message, CONNECT_UNAVAILABLE_MESSAGE);
  assert.equal(fromStatus(429).retryable, true);
  assert.equal(fromStatus(503).code, 'provider_unavailable');
  assert.equal(fromStatus(401).code, 'provider_auth');
  assert.equal(fromStatus(400, 'An expired connected account already exists').code, 'stale_connection');
  for (const status of [400, 401, 429, 503]) assert.doesNotMatch(fromStatus(status).message, /ac_123|Composio|status code/);
  const typed = new ComposioConnectError('no_connection_needed', 'x');
  assert.equal(classifyConnectError(typed), typed);
});

test('Twitter-style app without managed auth is refused without creating an auth config or link, whatever the caller claims', async () => {
  await withComposio([[/GET \/api\/v3\.1\/toolkits\/twitter/, () => json(TWITTER)]], async (service, calls) => {
    await assert.rejects(
      service.createConnectLink('twitter', 'org-1', { userId: 'u1', toolkitMeta: { composioManagedAuthSchemes: ['OAUTH2'], noAuth: false } }),
      (error) => error.code === 'connect_unavailable' && error.message === CONNECT_UNAVAILABLE_MESSAGE,
    );
    assert.deepEqual(calls.map((call) => call.method), ['GET']);
    const [annotated] = service.annotateToolkitsConnectable([{ slug: 'twitter', authSchemes: ['OAUTH2'], composioManagedAuthSchemes: [] }]);
    assert.equal(annotated.connectable, false);
    assert.equal(annotated.connectBlockedReason, 'needs_custom_oauth_app');
  });
});

test('an operator-provided auth config makes a custom-app toolkit connectable', async () => {
  await withComposio([
    [/GET \/api\/v3\.1\/toolkits\/twitter/, () => json(TWITTER)],
    [/POST \/api\/v3\/connected_accounts\/link/, ({ body }) => json({ redirect_url: `https://connect.example/${body.auth_config_id}`, connected_account_id: 'ca_1', expires_at: 'soon' })],
  ], async (service) => {
    process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify({ twitter: 'ac_twitter' });
    const link = await service.createConnectLink('twitter', 'org-1', { userId: 'u1' });
    assert.equal(link.redirectUrl, 'https://connect.example/ac_twitter');
  });
});

test('managed apps reuse the enabled auto auth config instead of creating another', async () => {
  await withComposio([
    [/GET \/api\/v3\.1\/toolkits\/gmail/, () => json(GMAIL)],
    [/GET \/api\/v3\.1\/auth_configs/, () => json({ items: [{ id: 'ac_old', name: 'gmail-auto', status: 'DISABLED' }, { id: 'ac_auto', name: 'gmail-auto', status: 'ENABLED' }] })],
    [/POST \/api\/v3\/connected_accounts\/link/, ({ body }) => json({ redirect_url: `https://connect.example/${body.auth_config_id}`, connected_account_id: 'ca_1', expires_at: 'soon' })],
  ], async (service, calls) => {
    const link = await service.createConnectLink('gmail', 'org-1', { userId: 'u1' });
    assert.equal(link.redirectUrl, 'https://connect.example/ac_auto');
    assert.equal(calls.filter((call) => call.method === 'POST' && call.path.includes('auth_configs')).length, 0);
  });
});

test('a stale expired connection is replaced once and the link is retried; ACTIVE accounts are untouched', async () => {
  let linkAttempts = 0;
  const deleted = [];
  await withComposio([
    [/GET \/api\/v3\.1\/toolkits\/gmail/, () => json(GMAIL)],
    [/GET \/api\/v3\.1\/auth_configs/, () => json({ items: [{ id: 'ac_auto', name: 'gmail-auto', status: 'ENABLED' }] })],
    [/POST \/api\/v3\/connected_accounts\/link/, () => (++linkAttempts === 1
      ? json({ error: { message: 'An expired connected account already exists' } }, 400)
      : json({ redirect_url: 'https://connect.example/ok', connected_account_id: 'ca_2', expires_at: 'soon' }))],
    [/GET \/api\/v3\.1\/connected_accounts/, () => json({ items: [
      { id: 'ca_expired', status: 'EXPIRED', toolkit: { slug: 'gmail' } },
      { id: 'ca_active_other', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
      { id: 'ca_expired_other_app', status: 'EXPIRED', toolkit: { slug: 'notion' } },
    ] })],
    [/DELETE \/api\/v3\.1\/connected_accounts\//, ({ path }) => { deleted.push(path.split('/').pop()); return json({}); }],
  ], async (service) => {
    const link = await service.createConnectLink('gmail', 'org-1', { userId: 'u1' });
    assert.equal(link.redirectUrl, 'https://connect.example/ok');
    assert.equal(linkAttempts, 2);
    assert.deepEqual(deleted, ['ca_expired']);
  });
});

test('an upstream 400 that is not a stale connection becomes a safe message and is not retried', async () => {
  let linkAttempts = 0;
  await withComposio([
    [/GET \/api\/v3\.1\/toolkits\/gmail/, () => json(GMAIL)],
    [/GET \/api\/v3\.1\/auth_configs/, () => json({ items: [{ id: 'ac_auto', name: 'gmail-auto', status: 'ENABLED' }] })],
    [/POST \/api\/v3\/connected_accounts\/link/, () => { linkAttempts++; return json({ error: { message: 'Invalid auth config ac_auto' } }, 400); }],
  ], async (service) => {
    await assert.rejects(service.createConnectLink('gmail', 'org-1', { userId: 'u1' }), (error) => error.code === 'connect_unavailable' && !/ac_auto/.test(error.message));
    assert.equal(linkAttempts, 1);
  });
});

test('health assessment separates blocked-by-design apps from broken auth configs', () => {
  const toolkits = [
    { slug: 'gmail', authSchemes: ['OAUTH2'], composioManagedAuthSchemes: ['OAUTH2'] },
    { slug: 'notion', authSchemes: ['OAUTH2'], composioManagedAuthSchemes: ['OAUTH2'] },
    { slug: 'linkedin', authSchemes: ['OAUTH2'], composioManagedAuthSchemes: ['OAUTH2'] },
    { slug: 'slack', authSchemes: ['OAUTH2'], composioManagedAuthSchemes: ['OAUTH2'] },
    { slug: 'twitter', authSchemes: ['OAUTH2'], composioManagedAuthSchemes: [] },
    { slug: 'serpapi', authSchemes: ['API_KEY'], composioManagedAuthSchemes: [] },
    { slug: 'weather', noAuth: true },
  ];
  const configs = [
    { id: 'ac_g', toolkit: 'gmail', name: 'gmail-auto', status: 'ENABLED' },
    { id: 'ac_n', toolkit: 'notion', name: 'notion-auto', status: 'DISABLED' },
    { id: 'ac_li', toolkit: 'linkedin', name: 'li', status: 'DISABLED' },
  ];
  const ids = { linkedin: 'ac_li', slack: 'ac_missing' };
  const result = assessConnectHealth(toolkits, configs, (slug) => ids[slug] || null);
  assert.deepEqual(result.failures, { notion: 'auth_config_disabled', linkedin: 'auth_config_disabled', slack: 'auth_config_missing' });
  assert.deepEqual(result.blocked, ['twitter']);
  assert.deepEqual(result.counts, { toolkits: 7, connectable: 1, apiKey: 1, noAuth: 1, blocked: 1, failures: 3 });
});

test('the daily run publishes overrides, logs counts and raises an alarm only for failures; an unreadable Composio is an alarm too', async () => {
  const lines = []; const alarms = []; let published;
  const deps = {
    loadToolkits: async () => [{ slug: 'notion', authSchemes: ['OAUTH2'], composioManagedAuthSchemes: ['OAUTH2'] }],
    request: async () => ({ items: [{ id: 'ac_n', toolkit: { slug: 'notion' }, name: 'notion-auto', status: 'DISABLED' }], next_cursor: null }),
    configuredId: () => null,
    setOverrides: (value) => { published = value; },
    log: (line) => lines.push(line),
    alarm: (line) => alarms.push(line),
  };
  const result = await runComposioConnectHealth(deps);
  assert.deepEqual(published, { notion: 'auth_config_disabled' });
  assert.equal(result.counts.failures, 1);
  assert.match(lines[0], /^\[composio-connect-health\] \{/);
  assert.match(alarms[0], /ALARM broken_connect notion:auth_config_disabled/);

  lines.length = 0; alarms.length = 0;
  const healthy = await runComposioConnectHealth({ ...deps, request: async () => ({ items: [{ id: 'ac_n', toolkit: { slug: 'notion' }, name: 'notion-auto', status: 'ENABLED' }] }) });
  assert.equal(healthy.counts.failures, 0);
  assert.equal(alarms.length, 0);

  const down = await runComposioConnectHealth({ ...deps, request: async () => { throw Object.assign(new Error('boom'), { status: 503 }); } });
  assert.equal(down, null);
  assert.match(alarms[0], /ALARM check_failed status=503/);
});

import test from 'node:test';
import assert from 'node:assert/strict';

test('Composio execution uses the v3.1 catalog with tenant-scoped structured arguments', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.COMPOSIO_API_KEY;
  const calls = [];
  process.env.COMPOSIO_API_KEY = 'test-key';
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ successful: true, data: { items: [] }, error: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const { executeTool } = await import(`../../src/connectors/composio/composio-service.js?test=${Date.now()}`);
    const result = await executeTool('org-1', 'INSTAGRAM_GET_IG_USER_MEDIA', {
      ig_user_id: 'me',
      limit: 100,
    });

    assert.equal(result.successful, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://backend.composio.dev/api/v3.1/tools/execute/INSTAGRAM_GET_IG_USER_MEDIA');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      user_id: 'org-1',
      arguments: { ig_user_id: 'me', limit: 100 },
      version: 'latest',
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = originalKey;
  }
});

test('Composio browser connections use the authenticated user subject for every lifecycle operation', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.COMPOSIO_API_KEY;
  const originalConfigs = process.env.COMPOSIO_AUTH_CONFIGS;
  const calls = [];
  process.env.COMPOSIO_API_KEY = 'test-key';
  process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify({ gmail: 'ac_gmail' });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).includes('/connected_accounts?')) {
      return new Response(JSON.stringify({
        items: [{ id: 'ca_gmail', toolkit: { slug: 'gmail' }, status: 'ACTIVE' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (options.method === 'DELETE') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).endsWith('/api/v3/connected_accounts/link')) {
      return new Response(JSON.stringify({
        redirect_url: 'https://connect.example/gmail',
        connected_account_id: 'ca_new',
        expires_at: '2030-01-01T00:00:00Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).endsWith('/api/v3/connected_accounts')) {
      return new Response(JSON.stringify({ id: 'ca_api', status: 'ACTIVE' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
  };

  try {
    const service = await import(`../../src/connectors/composio/composio-service.js?user-scope=${Date.now()}`);
    const scope = { userId: 'user-9', connectionScope: 'user' };
    await service.listConnectedAccounts('org-1', scope);
    await service.createConnectLink('gmail', 'org-1', { ...scope, callbackUrl: 'https://app.example/callback' });
    await service.createApiKeyConnection('org-1', 'gmail', 'secret-value', scope);
    await service.disconnectToolkit('org-1', 'gmail', scope);

    const listCalls = calls.filter(({ url }) => String(url).includes('/connected_accounts?'));
    assert.equal(listCalls.length, 2);
    for (const call of listCalls) assert.match(call.url, /user_ids=org-1%3Auser-9$/);

    const linkCall = calls.find(({ url }) => String(url).endsWith('/api/v3/connected_accounts/link'));
    assert.equal(JSON.parse(linkCall.options.body).user_id, 'org-1:user-9');

    const apiKeyCall = calls.find(({ url }) => String(url).endsWith('/api/v3/connected_accounts'));
    assert.equal(JSON.parse(apiKeyCall.options.body).connection.user_id, 'org-1:user-9');
    assert.ok(calls.some(({ url, options }) => options.method === 'DELETE' && String(url).endsWith('/ca_gmail')));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = originalKey;
    if (originalConfigs === undefined) delete process.env.COMPOSIO_AUTH_CONFIGS;
    else process.env.COMPOSIO_AUTH_CONFIGS = originalConfigs;
  }
});

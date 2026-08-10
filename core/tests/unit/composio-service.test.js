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

import test from 'node:test';
import assert from 'node:assert/strict';

async function loadInternalFetch(query) {
  const moduleUrl = new URL(`../../src/internal/internal-fetch.js?${query}`, import.meta.url);
  return import(moduleUrl.href);
}

test('internal fetch injects master key, trace id, and tenant headers', async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    HIVEMIND_MASTER_API_KEY: process.env.HIVEMIND_MASTER_API_KEY,
  };
  process.env.NODE_ENV = 'production';
  process.env.HIVEMIND_MASTER_API_KEY = 'prod-master';

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const mod = await loadInternalFetch(`headers=${Date.now()}`);
    const response = await mod.internalFetch('http://hm-core.local/test', {
      service: 'hm-core',
      method: 'POST',
      userId: 'user-1',
      orgId: 'org-1',
      body: { hello: 'world' },
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers['X-API-Key'], 'prod-master');
    assert.equal(calls[0].init.headers['X-HM-User-Id'], 'user-1');
    assert.equal(calls[0].init.headers['X-HM-Org-Id'], 'org-1');
    assert.ok(calls[0].init.headers['X-Request-Id']);
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].init.body, JSON.stringify({ hello: 'world' }));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

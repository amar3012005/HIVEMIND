import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaywrightServiceRuntime, validateResult } from '../../src/web/playwright-service-runtime.js';

test('validateResult preserves rendered evidence and provenance', () => {
  const result = validateResult({ pages: [{
    url: 'https://example.com/client-page', title: 'Rendered', text: 'Client content',
    links: [{ href: 'https://example.com/next' }], images: [], seo: { h1: ['Rendered'] },
    discovery: { source: 'rendered_link', depth: 1 },
  }], errors: [] });
  assert.equal(result.runtime_used, 'playwright-service');
  assert.equal(result.pages[0].rendered, true);
  assert.equal(result.pages[0].discovery.source, 'rendered_link');
});

test('Playwright service crawler sends one bounded authenticated crawl request', async () => {
  let request;
  const runtime = new PlaywrightServiceRuntime({
    endpoint: 'http://renderer.internal/v1/crawl', token: 'scoped-token', settleMs: 125,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ pages: [{ url: 'https://example.com/', links: [], images: [] }], errors: [] }) };
    },
  });
  const result = await runtime.crawl({ urls: ['https://example.com/'], depth: 2, pageLimit: 12 });
  assert.equal(request.url, 'http://renderer.internal/v1/crawl');
  assert.equal(request.options.headers.authorization, 'Bearer scoped-token');
  assert.deepEqual(JSON.parse(request.options.body), {
    urls: ['https://example.com/'], depth: 2, page_limit: 12, settle_ms: 125, capture_screenshot: false, allow_subdomains: false,
  });
  assert.equal(result.pages[0].rendered, true);
});

test('Playwright service blocks unsafe seeds and missing credentials before network access', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; };
  const runtime = new PlaywrightServiceRuntime({ token: 'token', fetchImpl });
  await assert.rejects(() => runtime.crawl({ urls: ['http://127.0.0.1/private'] }), /public-web policy/);
  await assert.rejects(() => runtime.crawl({ urls: ['https://example.com/', 'https://other.example/'] }), /same-origin/);
  await assert.rejects(() => new PlaywrightServiceRuntime({ token: '', fetchImpl }).crawl({ urls: ['https://example.com/'] }), /credential/);
  assert.equal(calls, 0);
});

test('Playwright service reports explicit upstream failures', async () => {
  const runtime = new PlaywrightServiceRuntime({ token: 'token', fetchImpl: async () => ({
    ok: false, status: 502, json: async () => ({ error: 'browser unavailable' }),
  }) });
  await assert.rejects(() => runtime.crawl({ urls: ['https://example.com/'] }), /502.*browser unavailable/);
});

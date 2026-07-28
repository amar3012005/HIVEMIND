import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../../src/web/browser-runtime.js';

test('SEO static fallback preserves metadata and discovery provenance', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    url,
    text: async () => `<!doctype html><html><head>
      <title>Rendered fallback title</title>
      <meta name="description" content="A useful fallback description">
      <meta name="robots" content="index,follow">
      <link rel="canonical" href="${url}">
      <script type="application/ld+json">{"@type":"Organization"}</script>
    </head><body><main><h1>Fallback heading</h1><p>${'Useful evidence '.repeat(30)}</p>
      <a href="/about">About</a><a href="https://outside.example.org/">Outside</a>
    </main></body></html>`,
  });
  try {
    const runtime = new BrowserRuntime();
    runtime.lightpanda.crawl = async () => { throw new Error('browser unavailable'); };
    const result = await runtime.seoAudit({
      urls: ['https://example.com/', 'https://example.com/sitemap-page'], depth: 1, pageLimit: 3,
    });
    assert.equal(result.runtime_used, 'fetch');
    assert.equal(result.pages[0].seo.h1[0], 'Fallback heading');
    assert.equal(result.pages[0].seo.robots, 'index,follow');
    assert.equal(result.pages[0].discovery.source, 'seed');
    assert.equal(result.pages[1].discovery.source, 'rendered_link');
    assert.ok(result.pages[0].wordCount > 20);
    assert.ok(result.pages.every((page) => new URL(page.url).origin === 'https://example.com'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

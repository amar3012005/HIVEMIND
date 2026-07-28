import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../../src/capabilities/registry.js';
import { runSeoSiteIntelligence } from '../../src/capabilities/seo-site-intelligence.js';

test('capability registry resolves an explicit or latest semantic version', () => {
  const registry = new CapabilityRegistry([
    { id: 'seo.example', version: '1.0.0', rooms: ['seo'] },
    { id: 'seo.example', version: '1.1.0', rooms: ['seo'] },
  ]);
  assert.equal(registry.resolve('seo.example').version, '1.1.0');
  assert.equal(registry.resolve('seo.example@1.0.0').version, '1.0.0');
  assert.equal(registry.list({ room: 'seo' }).length, 2);
});

test('SEO site intelligence emits durable stages and a versioned evidence artifact', async () => {
  const stages = [];
  const fetchImpl = async (url) => ({
    url, status: 200, ok: true,
    text: async () => url.endsWith('/robots.txt')
      ? 'Sitemap: https://example.com/sitemap.xml'
      : '<urlset><url><loc>https://example.com/about</loc></url></urlset>',
  });
  const browserRuntime = {
    seoAudit: async ({ urls }) => ({
      pages: urls.map((url, index) => ({
        url, title: `Useful page title ${index}`, description: 'Description', canonical: url,
        h1: ['Heading'], wordCount: 400, jsonLd: '{}', links: [],
        discovery: { source: index ? 'sitemap' : 'seed', depth: 0 },
      })),
      errors: [], runtime_used: 'lightpanda', fallback_applied: false, duration_ms: 25,
    }),
  };
  const result = await runSeoSiteIntelligence({
    seedUrl: 'https://example.com/', pageLimit: 10, browserRuntime, fetchImpl,
    onStage: async (event) => stages.push(`${event.stage}:${event.status}`),
  });
  assert.equal(result.audit.capability.id, 'seo.site-intelligence');
  assert.equal(result.audit.capability.version, '1.0.0');
  assert.equal(result.audit.coverage.pages_scanned, 2);
  assert.deepEqual(stages, [
    'site_discovery:running', 'site_discovery:succeeded',
    'rendered_crawl:running', 'rendered_crawl:succeeded',
    'evidence_compilation:running', 'evidence_compilation:succeeded',
  ]);
});

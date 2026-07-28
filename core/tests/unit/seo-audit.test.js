import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSeoAudit, inspectSeoSiteFiles } from '../../src/web/seo-audit.js';

test('compileSeoAudit turns crawler evidence into stable prioritized findings', () => {
    const audit = compileSeoAudit({
      seedUrl: 'https://example.com',
      pages: [{
        url: 'https://example.com/', title: '', description: '', status: 200,
        wordCount: 80, images: [{ src: '/hero.jpg', alt: '' }], links: [],
        seo: { canonical: '', robots: 'index,follow', h1: [] },
      }],
      errors: [{ target: 'https://example.com/missing', type: 'navigation_failed', error: '404' }],
      runtimeUsed: 'playwright',
      scannedAt: '2026-07-28T00:00:00.000Z',
    });
    assert.equal(audit.schema, 'seo-audit-v1');
    assert.deepEqual(audit.coverage, { pages_scanned: 1, crawl_errors: 1 });
    assert.equal(audit.severity.high, 2);
    assert.ok(audit.findings.map((row) => row.rule).includes('title_missing'));
    assert.equal(audit.pages[0].template, 'homepage');
    assert.ok(audit.score < 100);
    assert.equal(audit.limitations.length, 3);
});

test('inspectSeoSiteFiles follows robots sitemap declarations', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return {
      url,
      status: 200,
      ok: true,
      text: async () => url.endsWith('/robots.txt') ? 'User-agent: *\nSitemap: https://example.com/site-index.xml' : '<urlset />',
    };
  };
  const files = await inspectSeoSiteFiles('https://example.com/', fakeFetch);
  assert.deepEqual(calls, ['https://example.com/robots.txt', 'https://example.com/site-index.xml']);
  assert.equal(files.robots.present, true);
  assert.equal(files.sitemap.declared_in_robots, true);
});

test('compileSeoAudit aggregates repeated template findings without losing examples', () => {
    const pages = ['/blog/a', '/blog/b'].map((path) => ({
      url: `https://example.com${path}`, title: 'A sufficiently descriptive page title',
      description: 'Useful result description', canonical: `https://example.com${path}`,
      h1: ['Heading'], wordCount: 500, jsonLd: '{}', images: [], links: [],
    }));
    const audit = compileSeoAudit({ pages });
    const repeated = audit.findings.find((row) => row.rule === 'canonical_missing');
    assert.equal(repeated, undefined);
    assert.deepEqual(audit.templates[0], { template: '/blog/:slug', pages: 2, issues: 0 });
});

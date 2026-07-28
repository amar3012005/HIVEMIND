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
    assert.deepEqual(audit.coverage, { pages_scanned: 1, pages_discovered: 1, sitemap_urls_found: 0, crawl_errors: 1 });
    assert.equal(audit.severity.high, 2);
    assert.ok(audit.findings.map((row) => row.rule).includes('title_missing'));
    assert.equal(audit.pages[0].template, 'homepage');
    assert.ok(audit.score < 100);
    assert.equal(audit.limitations.length, 3);
    assert.equal(audit.evidence_quality.level, 'rendered');
});

test('compileSeoAudit marks static fallback evidence and health as provisional', () => {
  const audit = compileSeoAudit({
    seedUrl: 'https://example.com/', runtimeUsed: 'fetch',
    pages: [{ url: 'https://example.com/', title: 'Static response', wordCount: 100, links: [] }],
  });
  assert.equal(audit.evidence_quality.level, 'degraded');
  assert.equal(audit.evidence_quality.score_status, 'provisional');
  assert.match(audit.limitations[0], /degraded static-HTML audit/);
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
  assert.equal(files.discovery.urls_found, 0);
});

test('inspectSeoSiteFiles expands same-origin sitemap indexes into discovery candidates', async () => {
  const bodies = {
    'https://example.com/robots.txt': 'Sitemap: https://example.com/sitemap-index.xml',
    'https://example.com/sitemap-index.xml': '<sitemapindex><sitemap><loc>https://example.com/pages.xml</loc></sitemap><sitemap><loc>https://other.example.net/private.xml</loc></sitemap></sitemapindex>',
    'https://example.com/pages.xml': '<urlset><url><loc>https://example.com/about</loc></url><url><loc>https://example.com/blog/post</loc></url></urlset>',
  };
  const files = await inspectSeoSiteFiles('https://example.com/', async (url) => ({
    url, status: bodies[url] ? 200 : 404, ok: Boolean(bodies[url]), text: async () => bodies[url] || '',
  }));
  assert.deepEqual(files.discovery.urls, ['https://example.com/about', 'https://example.com/blog/post']);
  assert.equal(files.sitemap.files_checked, 2);
});

test('compileSeoAudit records discovery provenance and architecture evidence', () => {
  const audit = compileSeoAudit({
    seedUrl: 'https://example.com/',
    siteFiles: { discovery: { urls_found: 2, sitemap_urls_found: 1 } },
    pages: [
      { url: 'https://example.com/', title: 'Homepage title for testing', description: 'Home', canonical: 'https://example.com/', h1: ['Home'], wordCount: 300, jsonLd: '{}', links: [{ href: 'https://example.com/about' }], discovery: { source: 'seed', depth: 0 } },
      { url: 'https://example.com/about', title: 'About page title for testing', description: 'About', canonical: 'https://example.com/about', h1: ['About'], wordCount: 300, jsonLd: '{}', links: [], discovery: { source: 'sitemap', depth: 0 } },
    ],
  });
  assert.equal(audit.pages[1].internal_inlinks, 1);
  assert.equal(audit.pages[1].orphan_candidate, false);
  assert.equal(audit.coverage.pages_discovered, 2);
  assert.equal(audit.architecture.pages_without_internal_inlinks, 0);
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

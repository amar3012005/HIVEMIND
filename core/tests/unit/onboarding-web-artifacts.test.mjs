import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ONBOARDING_WEB_SOURCE,
  onboardingWebArtifactPayload,
  persistOnboardingWebArtifacts,
  renderOnboardingWebArtifactPreview,
} from '../../src/onboarding/web-artifacts.js';

test('normalizes a raw crawl into an inspectable web artifact contract', () => {
  const payload = onboardingWebArtifactPayload({
    url: 'https://example.com/about',
    title: 'About Example',
    content: 'The exact rendered page body.',
    links: ['https://example.com/contact'],
    provider: 'cf-browser-rendering',
    purpose: 'identity',
  }, { companyName: 'Example GmbH', capturedAt: '2026-09-19T10:00:00.000Z' });
  assert.equal(payload.contract, 'hivemind.onboarding-web-artifact.v1');
  assert.equal(payload.content, 'The exact rendered page body.');
  assert.equal(payload.company_name, 'Example GmbH');
  assert.deepEqual(payload.links, ['https://example.com/contact']);
});

test('persists raw pages as tenant-scoped immutable source artifacts', async () => {
  const created = [];
  const prisma = { sourceArtifact: {
    findFirst: async () => null,
    create: async ({ data }) => {
      created.push(data);
      return { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', createdAt: new Date() };
    },
  } };
  const artifacts = await persistOnboardingWebArtifacts({
    prisma,
    orgId: 'org-1',
    userId: 'user-1',
    companyName: 'Example',
    pages: [{ url: 'https://example.com/', content: '# Example\nFull raw crawl.', provider: 'firecrawl' }],
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].sourcePlatform, ONBOARDING_WEB_SOURCE);
  assert.equal(created[0].artifactType, 'web_crawl');
  assert.equal(created[0].payload.content, '# Example\nFull raw crawl.');
  assert.equal(artifacts[0].preview_url, '/v1/hyper/company/web-artifacts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/preview');
});

test('preview escapes captured markup while retaining readable crawl text', () => {
  const html = renderOnboardingWebArtifactPreview({ payload: {
    title: 'Observed <title>',
    url: 'https://example.com',
    content: '<script>alert(1)</script> Real text',
    links: [],
    provider: 'direct',
    purpose: 'company',
  } });
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Real text/);
  assert.doesNotMatch(html, /<script>alert/);
});

test('successful Cloudflare crawls are not replaced by the direct HTML fallback', () => {
  const server = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
  assert.match(server, /if \(firecrawlResearch\.provider === 'fallback'\)/);
  assert.doesNotMatch(server, /if \(firecrawlResearch\.provider !== 'firecrawl'\)/);
});

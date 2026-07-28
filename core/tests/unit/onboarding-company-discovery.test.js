import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCompanyPages, discoverHttpLinks, fallbackDomainHires, selectCompanyResearchPages } from '../../src/onboarding/company-discovery.js';
import { firstPartyResearchDigest, isFirstPartyUrl, normalizeCompanyProfile, researchCompanyWebsite, verifiedSocialProfiles } from '../../src/onboarding/company-research.js';

test('onboarding collects real same-site links without language-specific classification', () => {
  const html = `
    <nav>
      <a href="/私たちについて/">私たちについて</a>
      <a href="https://www.bundb.de/servicios?source=nav">Servicios</a>
      <a href="/réalisations">Réalisations</a>
      <a href="/kontakt">Kontakt</a>
      <a href="/polityka-prywatnosci">Polityka prywatności</a>
      <a href="https://linkedin.com/company/bundb">LinkedIn</a>
      <a href="/assets/portfolio.pdf">PDF</a>
    </nav>`;
  const pages = discoverCompanyPages(html, 'https://bundb.de/', { maxPages: 10 });
  assert.deepEqual(new Set(pages.map((page) => decodeURI(page.url))), new Set([
    'https://bundb.de/私たちについて',
    'https://www.bundb.de/servicios',
    'https://bundb.de/réalisations',
    'https://bundb.de/kontakt',
    'https://bundb.de/polityka-prywatnosci',
  ]));
  assert.equal(pages.some((page) => /about|product|pricing/.test(page.url)), false);
});

test('semantic selection is constrained to mapped first-party pages', () => {
  const pages = selectCompanyResearchPages([
    { url: 'https://example.jp/会社概要', title: '会社概要' },
    { url: 'https://example.jp/所在地', title: '所在地' },
    { url: 'https://example.jp/導入事例', title: '導入事例' },
  ], 'https://example.jp/', {
    maxPages: 4,
    semanticSelection: [
      { url: 'https://example.jp/所在地', purpose: 'location' },
      { url: 'https://example.jp/導入事例', purpose: 'proof' },
      { url: 'https://example.jp/invented', purpose: 'offering' },
      { url: 'https://attacker.example/会社概要', purpose: 'identity' },
    ],
  });
  assert.deepEqual(pages.map((page) => page.purpose), ['identity', 'location', 'proof']);
  assert.equal(pages.some((page) => page.url.includes('invented') || page.url.includes('attacker')), false);
});

test('invalid semantic output falls back to structurally diverse mapped pages', () => {
  const pages = selectCompanyResearchPages([
    'https://example.fr/entreprise',
    'https://example.fr/services/conseil',
    'https://example.fr/services/design',
  ], 'https://example.fr/', {
    maxPages: 3,
    semanticSelection: [{ url: 'https://example.fr/page-inventee', purpose: 'identity' }],
  });
  assert.equal(pages.length, 3);
  assert.equal(pages[0].url, 'https://example.fr/');
  assert.equal(pages.filter((page) => page.url.includes('/services/')).length, 1);
});

test('initial hires match a creative brand agency while preserving debate lenses', () => {
  const hires = fallbackDomainHires({
    industry: 'Brand and creative agency',
    what_it_does: 'Develops brand strategy, design systems, and campaigns.',
  });
  assert.deepEqual(hires.map((hire) => hire.title), [
    'Creative Director',
    'Brand & Audience Researcher',
    'Brand Quality Lead',
  ]);
  assert.deepEqual(new Set(hires.map((hire) => hire.archetype)), new Set(['strategist', 'investigator', 'skeptic']));
});

test('unknown domains receive a balanced domain-neutral operating team', () => {
  const hires = fallbackDomainHires({ industry: 'Specialty consulting' });
  assert.equal(hires.length, 3);
  assert.equal(hires.every((hire) => hire.field === 'Specialty consulting'), true);
  assert.deepEqual(hires.map((hire) => hire.archetype), ['strategist', 'investigator', 'skeptic']);
});

test('structural fallback remains useful without assigning semantic meaning to paths', () => {
  const pages = selectCompanyResearchPages([
    { url: 'https://example.com/oferta/jeden', title: 'Jeden' },
    { url: 'https://example.com/oferta/dwa', title: 'Dwa' },
    { url: 'https://example.com/empresa', title: 'Empresa' },
    { url: 'https://example.com/mentions-legales', title: 'Mentions légales' },
    { url: 'https://other.example/empresa', title: 'Wrong company' },
  ], 'https://example.com/', { maxPages: 4 });
  assert.equal(pages[0].url, 'https://example.com/');
  assert.equal(pages.filter((page) => page.url.includes('/oferta/')).length, 1);
  assert.equal(pages.every((page) => ['identity', 'company'].includes(page.purpose)), true);
  assert.equal(pages.some((page) => page.url.includes('other.example')), false);
});

test('onboarding identity digest accepts only first-party evidence', () => {
  assert.equal(isFirstPartyUrl('https://www.example.com/about', 'https://example.com'), true);
  assert.equal(isFirstPartyUrl('https://example.org/example-company', 'https://example.com'), false);
  const digest = firstPartyResearchDigest([
    { url: 'https://example.com/about', purpose: 'identity', content: 'Example builds software.' },
  ]);
  assert.match(digest, /SOURCE: https:\/\/example.com\/about/);
  assert.match(digest, /Example builds software/);
});

test('company location requires first-party evidence or an explicit user claim', () => {
  const rejected = normalizeCompanyProfile({
    name: 'Example', location: 'Paris, France', location_evidence_url: 'https://directory.example.org/example',
  }, { websiteUrl: 'https://example.com', fallbackName: 'EXAMPLE' });
  assert.equal(rejected.location, '');
  assert.equal(rejected.location_source, 'unknown');

  const claimed = normalizeCompanyProfile({ name: 'Example', location: 'Wrong transformed value' }, {
    websiteUrl: 'https://example.com', fallbackName: 'EXAMPLE', claimedLocation: 'Berlin, Germany',
  });
  assert.equal(claimed.location, 'Berlin, Germany');
  assert.equal(claimed.location_source, 'user_claim');

  const verified = normalizeCompanyProfile({
    name: 'Example', location: 'Munich, Germany', location_evidence_url: 'https://example.com/impressum',
  }, { websiteUrl: 'https://example.com', fallbackName: 'EXAMPLE' });
  assert.equal(verified.location, 'Munich, Germany');
  assert.equal(verified.location_source, 'first_party');
});

test('social profiles require a first-party link and can be corroborated by search', () => {
  const profiles = verifiedSocialProfiles([{
    url: 'https://example.com/',
    links: [
      'https://www.linkedin.com/company/example-co/?trk=site',
      'https://x.com/exampleco',
      'https://x.com/intent/post?text=share',
      'https://www.instagram.com/explore/tags/example',
      'https://attacker.example/exampleco',
    ],
  }], [
    { url: 'https://linkedin.com/company/example-co' },
    { url: 'https://instagram.com/unlinked-account' },
  ]);
  assert.deepEqual(profiles, [
    {
      platform: 'linkedin',
      url: 'https://linkedin.com/company/example-co',
      source_url: 'https://example.com/',
      verified_by: ['first_party', 'search'],
    },
    {
      platform: 'x',
      url: 'https://x.com/exampleco',
      source_url: 'https://example.com/',
      verified_by: ['first_party'],
    },
  ]);
});

test('direct-fetch fallback preserves first-party and social links', () => {
  const links = discoverHttpLinks(`
    <a href="/leistungen">Services</a>
    <a href="https://www.linkedin.com/company/example-co/?trk=website">LinkedIn</a>
    <a href="mailto:hello@example.com">Email</a>
  `, 'https://example.com/');
  assert.deepEqual(links, [
    'https://example.com/leistungen',
    'https://www.linkedin.com/company/example-co/?trk=website',
  ]);
});

test('bounded Firecrawl crawl accepts complete data before the status label catches up', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'POST') {
      return new Response(JSON.stringify({ success: true, id: 'crawl-1' }), { status: 200 });
    }
    return new Response(JSON.stringify({
      success: true,
      status: 'scraping',
      total: 1,
      completed: 1,
      creditsUsed: 1,
      data: [{
        markdown: 'Example builds useful software.',
        links: ['https://linkedin.com/company/example'],
        metadata: { sourceURL: 'https://example.com/', title: 'Example' },
      }],
    }), { status: 200 });
  };
  try {
    const result = await researchCompanyWebsite('https://example.com/', {
      apiKey: 'test-key',
      maxPages: 5,
      pollDelays: [0],
    });
    assert.equal(result.provider, 'firecrawl');
    assert.equal(result.pages.length, 1);
    assert.equal(result.credits_used, 1);
    assert.equal(calls.length, 3);
    const crawlCall = calls.find((call) => call.body?.limit === 5);
    assert.equal(crawlCall.body.maxConcurrency, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Firecrawl homepage preview survives a crawl-start failure', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (String(url).endsWith('/scrape')) {
      assert.equal(body.formats.some((format) => format?.type === 'screenshot'), true);
      return new Response(JSON.stringify({
        success: true,
        data: {
          markdown: 'Contact hello@example.com or [call](tel:+49 511 12345678).',
          links: ['https://linkedin.com/company/example', 'mailto:hello@example.com', 'tel:+49 511 12345678'],
          screenshot: 'https://cdn.example.com/homepage.png',
          metadata: { sourceURL: 'https://example.com/', title: 'Example' },
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false, error: 'crawl unavailable' }), { status: 503 });
  };
  try {
    const result = await researchCompanyWebsite('https://example.com/', { apiKey: 'test-key', maxPages: 5 });
    assert.equal(result.provider, 'firecrawl');
    assert.equal(result.pages.length, 1);
    assert.equal(result.screenshot, 'https://cdn.example.com/homepage.png');
    assert.deepEqual(result.contacts, { emails: ['hello@example.com'], phones: ['+49 511 12345678'] });
  } finally {
    global.fetch = originalFetch;
  }
});

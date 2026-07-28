import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCompanyPages, fallbackDomainHires, selectCompanyResearchPages } from '../../src/onboarding/company-discovery.js';
import { firstPartyResearchDigest, isFirstPartyUrl, normalizeCompanyProfile } from '../../src/onboarding/company-research.js';

test('onboarding follows real same-site homepage links instead of guessed paths', () => {
  const html = `
    <nav>
      <a href="/agentur/">Agentur</a>
      <a href="https://www.bundb.de/leistungen?source=nav">Leistungen</a>
      <a href="/arbeiten">Referenzen</a>
      <a href="/kontakt">Kontakt</a>
      <a href="/impressum">Impressum</a>
      <a href="/datenschutzerklaerung">Datenschutz</a>
      <a href="https://linkedin.com/company/bundb">LinkedIn</a>
      <a href="/assets/portfolio.pdf">PDF</a>
    </nav>`;
  const pages = discoverCompanyPages(html, 'https://bundb.de/', { maxPages: 5 });
  assert.deepEqual(pages.map((page) => page.url), [
    'https://bundb.de/agentur',
    'https://www.bundb.de/leistungen',
    'https://bundb.de/arbeiten',
    'https://bundb.de/kontakt',
  ]);
  assert.equal(pages.some((page) => /about|product|pricing/.test(page.url)), false);
});

test('onboarding fallback can include imprint pages specifically for location evidence', () => {
  const html = '<a href="/privacy">Privacy</a><a href="/impressum">Impressum</a><a href="/about">About</a>';
  const pages = discoverCompanyPages(html, 'https://example.de/', { maxPages: 5, includeLocationPages: true });
  assert.equal(pages.some((page) => page.url === 'https://example.de/impressum'), true);
  assert.equal(pages.some((page) => page.url === 'https://example.de/privacy'), false);
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

test('Firecrawl map selection preserves identity, offering, proof, and location evidence', () => {
  const pages = selectCompanyResearchPages([
    { url: 'https://example.com/products/one', title: 'Product one' },
    { url: 'https://example.com/products/two', title: 'Product two' },
    { url: 'https://example.com/about', title: 'About us' },
    { url: 'https://example.com/impressum', title: 'Impressum' },
    { url: 'https://example.com/customers', title: 'Customers' },
    { url: 'https://other.example/about', title: 'Wrong company' },
  ], 'https://example.com/', { maxPages: 5 });
  assert.equal(pages[0].url, 'https://example.com/');
  assert.equal(pages.some((page) => page.purpose === 'location'), true);
  assert.equal(pages.some((page) => page.purpose === 'proof'), true);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCompanyPages, fallbackDomainHires } from '../../src/onboarding/company-discovery.js';

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

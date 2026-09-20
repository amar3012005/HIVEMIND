import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDayZeroOnboardingReport, renderDayZeroOnboardingEmail } from '../../src/email/templates/day0-company-onboarding.js';
import { renderDayZeroPortraitV8 } from '../../src/email/templates/day0-portrait-v8.js';

const company = {
  company: 'Canary Company',
  website: 'https://canary.example',
  company_location: 'Berlin, Germany',
  mission: 'Make accountable company intelligence available to every team.',
  profile: {
    tagline: 'Intelligence that moves work forward',
    what_it_does: 'Turns retained company context into coordinated work.',
    positioning: 'An evidence-grounded operating system for teams.',
    offer: 'Company memory, digital employees, operating rooms, and voice.',
    icp: 'Regulated European teams that need durable organizational context.',
    unknowns: ['Confirm the primary buyer and the first regulated market.'],
    contact_details: { emails: ['hello@canary.example'] },
  },
  research: [{ title: 'Market landscape', summary: 'The first-party site emphasizes governed operations.', url: 'https://canary.example/market' }],
  documents: ['Company profile', 'Mission', 'Market research'],
  source_pages: [{ url: 'https://canary.example/product' }],
  tasks: [{ title: 'Map the first customer segment', room_name: 'Research', deliverable: 'A source-backed customer brief.' }],
  team: [{ id: 'researcher-1', name: 'Omar', roleArchetype: 'Researcher', jobTitle: 'Customer & Market Researcher' }],
};

test('Day 0 PDF uses the flowing Day 1 editorial grammar without changing the email renderer', () => {
  const report = buildDayZeroOnboardingReport(company, { appUrl: 'https://next.example.test/company' });
  const html = renderDayZeroPortraitV8(report, { screenshotDataUri: 'data:image/png;base64,AAAA' });
  const email = renderDayZeroOnboardingEmail(company, { appUrl: 'https://next.example.test/company' });

  assert.match(html, /@page\{size:A4 portrait/);
  assert.equal((html.match(/class="page"/g) || []).length, 1);
  assert.match(html, /HIVEMIND · COMPANY AWAKENING COMPLETE/);
  assert.match(html, /SOURCE &amp; EVIDENCE LEDGER · 07/);
  assert.match(html, /class="character-strip"/);
  assert.match(html, /data:image\/png;base64,AAAA/);
  for (const expected of ['Canary Company', 'Market landscape', 'Company profile', 'Map the first customer segment', 'Confirm the primary buyer', 'hello@canary.example']) {
    assert.match(html, new RegExp(expected));
  }

  assert.match(email.html, /DAY 0 · THE RISE OF AWAKENING/);
  assert.doesNotMatch(email.html, /COMPANY AWAKENING COMPLETE/);
  assert.doesNotMatch(email.html, /SOURCE &amp; EVIDENCE LEDGER/);
});

test('Day 0 attachment retains onboarding material beyond the old dashboard-card caps', () => {
  const expanded = {
    ...company,
    research: Array.from({ length: 12 }, (_, index) => ({
      title: `Research item ${index + 1}`,
      summary: `Evidence summary ${index + 1}`,
      url: `https://canary.example/research/${index + 1}`,
    })),
    documents: Array.from({ length: 16 }, (_, index) => `Onboarding document ${index + 1}`),
    tasks: Array.from({ length: 12 }, (_, index) => ({ title: `First move ${index + 1}`, room_name: 'Research' })),
  };
  const report = buildDayZeroOnboardingReport(expanded, { appUrl: 'https://next.example.test/company' });
  const html = renderDayZeroPortraitV8(report);
  assert.equal(report.researchItems.length, 12);
  assert.equal(report.documents.length, 16);
  assert.equal(report.firstMoves.length, 12);
  assert.match(html, /Research item 12/);
  assert.match(html, /Onboarding document 16/);
  assert.match(html, /First move 12/);
});

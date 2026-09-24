import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDayZeroOnboardingReport, DAY_ZERO_ONEPAGE_REPORT_VERSION, renderDayZeroOnboardingEmail } from '../../src/email/templates/day0-company-onboarding.js';
import { renderDayZeroPortraitV8 } from '../../src/email/templates/day0-portrait-v8.js';
import { renderDayZeroOnePageEditorial } from '../../src/email/templates/day0-onepage-editorial.js';
import { renderDayZeroOnboardingPdf } from '../../src/email/day0-company-report-pdf.js';

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
  assert.match(html, /@page\{size:A4 portrait;margin:24mm 0 18mm\}/);
  assert.match(html, /id="day0-print-pagination"/);
  assert.match(html, /\.page\{padding:0 15mm/);
  assert.match(html, /\.head\{display:none\}/);
  assert.doesNotMatch(html, /position:fixed/);
  assert.doesNotMatch(html, /print-document/);
  assert.match(html, /page-break-inside:avoid/);
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

test('the one-page editorial is a single white, SINGULANCE-branded Day 0 brief with real tenant context', () => {
  const report = buildDayZeroOnboardingReport(company, {
    appUrl: 'https://next.example.test/company',
    version: DAY_ZERO_ONEPAGE_REPORT_VERSION,
  });
  const html = renderDayZeroOnePageEditorial(report, { screenshotDataUri: 'data:image/png;base64,AAAA' });
  const email = renderDayZeroOnboardingEmail(company, { appUrl: 'https://next.example.test/company' });

  assert.equal((html.match(/<main class="page">/g) || []).length, 1);
  assert.match(html, /@page\{size:A4 portrait;margin:0\}/);
  assert.match(html, /SINGULANCE/);
  assert.match(html, /aria-label="Singulance"/);
  assert.match(html, /#117dff/);
  assert.match(html, /#ffffff|#fff/);
  assert.match(html, /Canary Company/);
  assert.match(html, /Make accountable company intelligence available/);
  assert.match(html, /Regulated European teams/);
  assert.match(html, /Map the first customer segment/);
  assert.match(html, /Omar/);
  assert.match(html, /data:image\/png;base64,AAAA/);
  assert.match(html, /EVIDENCE &amp; YOUR JUDGEMENT/);
  assert.match(email.html, /DAY 0 · THE RISE OF AWAKENING/);
  assert.doesNotMatch(email.html, /FIRST OPERATING MODEL · READY FOR REVIEW/);
});

test('Day 0 PDF asks Chromium for native repeated branding outside the content flow', async () => {
  const originalToken = process.env.PLAYWRIGHT_SERVICE_TOKEN;
  process.env.PLAYWRIGHT_SERVICE_TOKEN = 'unit-test-token';
  let requestBody;
  try {
    await renderDayZeroOnboardingPdf('<html><body>report</body></html>', {
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return new Response(new Uint8Array([37, 80, 68, 70]));
      },
    });
  } finally {
    if (originalToken === undefined) delete process.env.PLAYWRIGHT_SERVICE_TOKEN;
    else process.env.PLAYWRIGHT_SERVICE_TOKEN = originalToken;
  }
  assert.equal(requestBody.display_header_footer, true);
  assert.equal(requestBody.prefer_css_page_size, false);
  assert.deepEqual(requestBody.margin, { top: '24mm', right: '0mm', bottom: '18mm', left: '0mm' });
  assert.match(requestBody.header_template, /SINGULANCE/);
  assert.match(requestBody.footer_template, /SINGULANCE · HIVEMIND OPERATING SYSTEM/);
  assert.match(requestBody.footer_template, /pageNumber/);
  assert.match(requestBody.footer_template, /totalPages/);
});

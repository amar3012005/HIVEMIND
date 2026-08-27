import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDayZeroOnboardingEmail, renderDayZeroOnboardingReportHtml } from '../src/email/templates/day0-company-onboarding.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(here, '../../output/day0-lifecycle');

const fixture = {
  company: 'Singulance Labs',
  website: 'https://singulancelabs.com',
  company_location: 'Hannover, Germany',
  mission: 'Empower regulated European enterprises with a sovereign, privacy-first AI workforce that lives inside their own company memory.',
  onboarded_at: '2026-08-27T18:00:00Z',
  profile: {
    tagline: 'AI Workforce That Runs Inside Memory',
    what_it_does: 'A GDPR-native AI operating layer that gives companies durable memory, grounded recall, and digital employees able to turn context into action.',
    positioning: 'A sovereign AI operating system for institutions that need private memory, evidence-grounded decisions, and accountable execution.',
    offer: 'HIVEMIND, HyperAgents, Meeting Notes, Voice, and sovereign deployment.',
    icp: 'Large enterprises and regulated institutions in Europe seeking compliant internal AI capabilities.',
    evidence_gaps: ['Confirm the highest-priority buyer segment.', 'Approve the first operational use case.', 'Validate the public positioning statement.'],
    contact_details: { emails: ['enterprise@singulancelabs.com'] },
  },
  team: [
    { id: 'lena-kovacs', slug: 'lena-kovacs', name: 'Lena Kovács', roleArchetype: 'Product Risk & Quality Lead', focus: 'Protects product claims, reliability, privacy, and delivery quality.' },
    { id: 'ravi-patel', slug: 'ravi-patel', name: 'Ravi Patel', roleArchetype: 'User & Market Researcher', focus: 'Finds user needs, competition, and evidence of market adoption.' },
    { id: 'sofia-almeida', slug: 'sofia-almeida', name: 'Sofia Almeida', roleArchetype: 'Product Strategy Lead', focus: 'Owns product positioning, roadmap priorities, and differentiation.' },
  ],
  tasks: [
    { title: 'Audit and optimize core site keywords', room_name: 'SEO', deliverable: 'Keyword optimization report' },
    { title: 'Design the regulated-market lead funnel', room_name: 'Marketing', deliverable: 'Lead-generation funnel blueprint' },
    { title: 'Build a targeted outreach list of EU regulators', room_name: 'Outreach intelligence', deliverable: 'Verified prospect contact list' },
    { title: 'Refine the sovereign AI positioning statement', room_name: 'Branding', deliverable: 'Updated brand positioning brief' },
    { title: 'Prepare an investor deck highlighting the compliance edge', room_name: 'Fundraising', deliverable: 'Investor presentation deck' },
  ],
  documents: ['Singulance Labs - Company profile', 'Singulance Labs - Market research', 'Singulance Labs - Mission'],
  research: [
    { title: 'Company website', summary: 'First-party product, positioning, and contact context.', url: 'https://singulancelabs.com' },
    { title: 'HIVEMIND product', summary: 'Product capabilities and public operating-system narrative.', url: 'https://next.singulancelabs.com/hivemind/login' },
    { title: 'Public social signal', summary: 'Recent brand language and company announcements.', url: 'https://instagram.com/singulancelabs' },
  ],
};

await fs.mkdir(outputDir, { recursive: true });
const options = {
  appUrl: 'https://next.singulancelabs.com/hivemind/app/employees/mycompany',
  publicApiUrl: 'https://api.singulancelabs.com',
  embedEmailAvatars: true,
};
const email = renderDayZeroOnboardingEmail(fixture, options);
const deck = renderDayZeroOnboardingReportHtml(fixture, options);
await Promise.all([
  fs.writeFile(path.join(outputDir, 'day0-email-preview.html'), email.html),
  fs.writeFile(path.join(outputDir, 'day0-report-deck-preview.html'), deck.html),
  fs.writeFile(path.join(outputDir, 'day0-report-view-model.json'), `${JSON.stringify(deck.report, null, 2)}\n`),
]);
console.log(JSON.stringify({ outputDir, emailBytes: Buffer.byteLength(email.html), deckBytes: Buffer.byteLength(deck.html), pages: 10, avatars: deck.report.team.length }));

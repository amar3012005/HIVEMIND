import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDayZeroOnboardingEmail, renderDayZeroOnboardingReportHtml } from '../src/email/templates/day0-company-onboarding.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = path.join(root, 'output', 'pdf');
const pdfUrl = process.env.HIVEMIND_PLAYWRIGHT_PDF_URL || 'http://127.0.0.1:8932/v1/pdf';
const token = process.env.PLAYWRIGHT_SERVICE_TOKEN || '';
if (!token) throw new Error('PLAYWRIGHT_SERVICE_TOKEN is required');

const input = {
  company: 'Canary Company',
  website: 'https://canary.example',
  company_location: 'Berlin, Germany',
  mission: 'Give teams an accountable operating system for company intelligence.',
  onboarded_at: '2026-09-03T08:00:00.000Z',
  profile: {
    tagline: 'Company intelligence, ready to act.',
    what_it_does: 'Canary Company turns source-backed knowledge into practical work for operating teams.',
    positioning: 'A durable, evidence-first operating layer for modern companies.',
    offer: 'Company memory, governed agents, and reusable workflows.',
    icp: 'European operations, strategy, research, and compliance teams.',
    open_questions: ['Confirm the primary buyer.', 'Approve the first operating priority.'],
    contact_details: { emails: ['hello@canary.example'], phones: ['+49 30 000000'] },
    social_profiles: [{ url: 'https://www.linkedin.com/company/canary-example' }],
  },
  source_pages: [
    { url: 'https://canary.example/' },
    { url: 'https://canary.example/products' },
    { url: 'https://canary.example/company' },
    { url: 'https://canary.example/legal/privacy' },
  ],
  research: [
    { title: 'Regulated teams need accountable AI', summary: 'European operators require source-backed decisions, explicit authority, and durable audit trails.', url: 'https://canary.example/research/accountable-ai' },
    { title: 'Company memory is the operating context', summary: 'Reusable company knowledge reduces repeated discovery and keeps work grounded across teams.', url: 'https://canary.example/research/company-memory' },
  ],
  documents: ['Company profile', 'Market and audience brief', 'Operating priorities'],
  tasks: [
    { title: 'Validate the company narrative', room_name: 'Research', deliverable: 'A source-backed positioning brief.' },
    { title: 'Map the highest-value customer need', room_name: 'Market', deliverable: 'A ranked customer-needs report.' },
    { title: 'Review the first operating risk', room_name: 'Risk', deliverable: 'A review-ready risk memo.' },
  ],
  team: [
    { id: 'ravi-research', name: 'Ravi Patel', roleArchetype: 'Researcher', jobTitle: 'User & Market Researcher' },
    { id: 'lena-strategy', name: 'Lena', roleArchetype: 'Strategist', jobTitle: 'Company Strategist' },
    { id: 'priya-risk', name: 'Priya', roleArchetype: 'Skeptic', jobTitle: 'Independent Reviewer' },
    { id: 'omar-comms', name: 'Omar', roleArchetype: 'Communicator', jobTitle: 'Communicator' },
  ],
};

const email = renderDayZeroOnboardingEmail(input, { publicApiUrl: 'https://api.singulancelabs.com' });
const report = renderDayZeroOnboardingReportHtml(input);
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, 'day0-lifecycle-email-preview.html'), email.html, 'utf8');
await fs.writeFile(path.join(outputDir, 'day0-lifecycle-report-preview.html'), report.html, 'utf8');
const response = await fetch(pdfUrl, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ html: report.html }),
});
if (!response.ok) throw new Error(`PDF render failed: ${response.status} ${await response.text()}`);
const pdfPath = path.join(outputDir, 'day0-lifecycle-report-preview.pdf');
await fs.writeFile(pdfPath, Buffer.from(await response.arrayBuffer()));
console.log(pdfPath);

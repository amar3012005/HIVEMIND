import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDayOneEmail, renderDayOnePortraitReport } from '../src/lifecycle/day1-first-move.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = path.join(root, 'output', 'pdf');
const pdfUrl = process.env.HIVEMIND_PLAYWRIGHT_PDF_URL || 'http://127.0.0.1:8932/v1/pdf';
const token = process.env.PLAYWRIGHT_SERVICE_TOKEN || '';
if (!token) throw new Error('PLAYWRIGHT_SERVICE_TOKEN is required');

const input = {
  companyName: 'SINGULANCE',
  taskTitle: 'Closing the Highest-Risk Evidence Gaps - Q4 2026',
  roomUrl: 'https://next.preview.singulancelabs.com/hivemind/app/employees/rooms/preview',
  completedAt: '2026-08-29T18:00:00.000Z',
  publicApiUrl: 'https://preview-api.singulancelabs.com',
  characters: [
    { id: 'ava-research', name: 'Ava', role: 'Researcher' },
    { id: 'lena-strategy', name: 'Léna', role: 'Strategist' },
    { id: 'omar-skeptic', name: 'Omar', role: 'Risk & Compliance' },
    { id: 'priya-builder', name: 'Priya', role: 'Builder' },
  ],
  output: `# Closing the Highest-Risk Evidence Gaps - Q4 2026

## Executive Summary

Apple must close three critical evidence gaps before Q4 2026. The sealed report preserves all source characters unchanged: 日本語, भारत, العربية, café, €1,249, 82%, and 🚀.

| Region | Signal | Confidence | Owner |
|:---|---:|:---:|:---|
| भारत | **88 - positive** | High | Léna |
| الخليج | 82% | Medium | Omar |
| 日本 | €1,249 | High | Priya |

### Decision unlocked for other rooms

- **Product:** adjust the roadmap to the evidence threshold.
- **Marketing:** tailor campaigns without rewriting the sealed findings.

> Human judgement remains the final authority.

Long source URL: https://example.test/research/evidence/${'durable-segment/'.repeat(16)}

\`provider_receipt: cf-email/accepted/✓\`
`,
};

const email = renderDayOneEmail(input);
const reportHtml = renderDayOnePortraitReport(input);
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, 'day1-lifecycle-email-preview.html'), email.html, 'utf8');
await fs.writeFile(path.join(outputDir, 'day1-lifecycle-report-preview.html'), reportHtml, 'utf8');
const response = await fetch(pdfUrl, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ html: reportHtml }),
});
if (!response.ok) throw new Error(`PDF render failed: ${response.status} ${await response.text()}`);
const pdfPath = path.join(outputDir, 'day1-lifecycle-report-preview.pdf');
await fs.writeFile(pdfPath, Buffer.from(await response.arrayBuffer()));
console.log(pdfPath);

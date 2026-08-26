import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hyperArtifactsEnabled,
  reviewHyperArtifactVisualQuality,
  validateHyperArtifactHtml,
  validateHyperArtifactMedium,
} from '../../src/artifacts/hyper-artifacts.js';

const previousPrimary = process.env.Visual_path_In_Hyperrooms;
const previousAlias = process.env.VISUAL_PATH_IN_HYPERROOMS;
const previousGateway = process.env.CLOUDFLARE_AI_GATEWAY_ENABLED;

test.afterEach(() => {
  if (previousPrimary === undefined) delete process.env.Visual_path_In_Hyperrooms;
  else process.env.Visual_path_In_Hyperrooms = previousPrimary;
  if (previousAlias === undefined) delete process.env.VISUAL_PATH_IN_HYPERROOMS;
  else process.env.VISUAL_PATH_IN_HYPERROOMS = previousAlias;
  if (previousGateway === undefined) delete process.env.CLOUDFLARE_AI_GATEWAY_ENABLED;
  else process.env.CLOUDFLARE_AI_GATEWAY_ENABLED = previousGateway;
});

test('visual critic turns a low-quality verdict into concrete repair instructions', async () => {
  process.env.CLOUDFLARE_AI_GATEWAY_ENABLED = 'false';
  const calls = [];
  const verdict = await reviewHyperArtifactVisualQuality({
    desktopScreenshot: Buffer.from('desktop').toString('base64'),
    mobileScreenshot: Buffer.from('mobile').toString('base64'),
    intent: { kind: 'investor_deck' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          pass: false,
          score: 46,
          issues: ['Replace the stacked report cards with an investor narrative and visual revenue model.'],
          strengths: ['Readable typography.'],
        }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /openrouter\.ai/);
  assert.equal(verdict.reviewed, true);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.score, 46);
  assert.match(verdict.issues[0], /investor narrative/);
});

test('visual critic fails open when the review provider is unavailable', async () => {
  process.env.CLOUDFLARE_AI_GATEWAY_ENABLED = 'false';
  const verdict = await reviewHyperArtifactVisualQuality({
    desktopScreenshot: Buffer.from('desktop').toString('base64'),
    mobileScreenshot: Buffer.from('mobile').toString('base64'),
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(verdict.reviewed, false);
  assert.equal(verdict.passed, true);
  assert.equal(verdict.reason, 'critic_unavailable');
});

test('visual artifact path is disabled by default and honors the production flag', () => {
  delete process.env.Visual_path_In_Hyperrooms;
  delete process.env.VISUAL_PATH_IN_HYPERROOMS;
  assert.equal(hyperArtifactsEnabled(), false);
  process.env.Visual_path_In_Hyperrooms = 'True';
  assert.equal(hyperArtifactsEnabled(), true);
});

test('static artifact contract accepts self-contained HTML and rejects active external access', () => {
  const safe = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Board</title><style>body{font-family:system-ui}figure{display:grid}</style></head><body><main><h1>Operating board</h1><figure><svg viewBox="0 0 100 20" role="img"><title>Evidence signal</title><path d="M0 20L100 0"/></svg><figcaption>${'Evidence. '.repeat(100)}</figcaption></figure></main></body></html>`;
  assert.deepEqual(validateHyperArtifactHtml(safe), []);
  const cited = safe.replace('</p>', ' <a href="https://example.com/source">Source</a></p>');
  assert.deepEqual(validateHyperArtifactHtml(cited), []);
  const unsafe = safe.replace('</body>', '<script src="https://example.com/a.js"></script><script>fetch("https://example.com")</script></body>');
  const errors = validateHyperArtifactHtml(unsafe).join(' ');
  assert.match(errors, /External scripts/);
  assert.match(errors, /Network APIs/);
  assert.match(errors, /External loaded assets/);
  const stylesheetErrors = validateHyperArtifactHtml(
    safe.replace('</head>', '<link rel="stylesheet" href="https://example.com/a.css"></head>'),
  ).join(' ');
  assert.match(stylesheetErrors, /External loaded assets/);
});

test('quality floor rejects report-template residue and missing visual explanation', () => {
  const weak = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Report</title><style>body{font-family:system-ui}</style></head><body><main><h1>Report</h1><p>**Projected result** (source) ${'Narrative. '.repeat(100)}</p></main></body></html>`;
  const errors = validateHyperArtifactHtml(weak).join(' ');
  assert.match(errors, /Markdown residue/);
  assert.match(errors, /meaningful evidence labels/);
  assert.match(errors, /meaningful visual explanation/);
});

test('presentation intent requires a real navigable slide sequence', () => {
  const report = '<!doctype html><html><head><style>@media print{main{display:block}}</style></head><body><main><section>Memo</section></main></body></html>';
  const errors = validateHyperArtifactMedium(report, { kind: 'presentation' }).join(' ');
  assert.match(errors, /at least five semantic slide sections/);
  assert.match(errors, /next\/previous slide navigation/);
  assert.match(errors, /print-friendly slide page breaks/);

  const deck = `<!doctype html><html data-mode="editorial"><head><style>
    @media print { .slide { break-after: page; } }
  </style></head><body><main>
    <section class="slide composition-hero" data-slide="1">Thesis</section>
    <section class="slide composition-comparison" data-slide="2">Evidence</section>
    <section class="slide composition-process" data-slide="3">Model</section>
    <section class="slide composition-comparison" data-slide="4">Risk</section>
    <section class="slide composition-decision" data-slide="5">Decision</section>
    <button class="previous-slide" aria-label="Previous slide">Back</button>
    <button class="next-slide" aria-label="Next slide">Next</button>
  </main></body></html>`;
  assert.deepEqual(validateHyperArtifactMedium(deck, { kind: 'presentation' }), []);
  assert.deepEqual(validateHyperArtifactMedium(report, { kind: 'interactive_document' }), []);
});

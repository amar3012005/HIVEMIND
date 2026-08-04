/**
 * The normalisation contract, one fixture per format.
 *
 * This is what makes the seam non-patchwork: adding a format means adding an implementation AND a
 * case here, and it becomes impossible to ship a format that silently emits no structure — which is
 * exactly what happened before (docx / pptx / html at 0% markdown headings corpus-wide while .md sat
 * at 100%), and impossible to ship a tier that stringifies a binary container as "text" (measured:
 * 4 documents produced 642 segments, 636 of them raw ZIP/PDF bytes, chunked and indexed).
 *
 * Two invariants:
 *   1. `markdown` is markdown or null — NEVER flat text dressed as markdown.
 *   2. Binary input FAILS (ok:false) rather than being indexed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, binaryRatio, looksBinary, htmlToMarkdown, asMarkdown, sanitizeText } from '../../src/knowledge/normalize.js';

const buf = (s) => Buffer.from(s, 'utf-8');

test('markdown source keeps its headings', async () => {
  const r = await normalize(buf('# Title\n\nBody text.'), { filename: 'a.md' });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'markdown-native');
  assert.match(r.markdown, /^# Title/);
});

test('plain text without headings reports markdown as NULL, not itself', async () => {
  const r = await normalize(buf('Just prose with no structure at all.'), { filename: 'a.txt' });
  assert.equal(r.ok, true);
  assert.equal(r.markdown, null, 'flat text must not be aliased as markdown');
  assert.ok(r.text.length > 0);
});

test('html <h1>-<h6> become markdown headings', async () => {
  const r = await normalize(buf('<h1>Executive Summary</h1><p>Body.</p>'), { filename: 'a.html' });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'html-markdown');
  assert.match(r.markdown, /^# Executive Summary/);
});

test('csv is text, never markdown', async () => {
  const r = await normalize(buf('a,b\n1,2\n'), { filename: 'a.csv' });
  assert.equal(r.ok, true);
  assert.equal(r.markdown, null);
});

test('a ZIP container FAILS instead of being stringified — the production defect', async () => {
  // PK\x03\x04 plus NUL-heavy bytes: what a .pptx/.docx/.xlsx actually is.
  const zip = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(400), Buffer.from('\x01\x02\x03\x04\x05')]);
  const r = await normalize(zip, { filename: 'deck.pptx' });
  assert.equal(r.ok, false, 'binary must never be reported as parsed text');
  assert.equal(r.markdown, null);
  assert.equal(r.text, '');
  assert.match(r.error, /non-text|binary/i);
});

test('a text file whose bytes are actually binary also fails', async () => {
  const fake = Buffer.concat([Buffer.from('hello'), Buffer.alloc(300)]);
  const r = await normalize(fake, { filename: 'a.txt' });
  assert.equal(r.ok, false);
  assert.match(r.error, /non-text/i);
});

test('empty file fails cleanly', async () => {
  const r = await normalize(Buffer.alloc(0), { filename: 'a.txt' });
  assert.equal(r.ok, false);
});

test('binary sniff: prose is 0, NUL-padding is high', () => {
  assert.equal(binaryRatio('normal prose with ümlauts and\ttabs\n'), 0);
  assert.ok(binaryRatio('a'.repeat(10) + '\x00'.repeat(90)) > 0.5);
  assert.equal(looksBinary('clean text'), false);
  assert.equal(looksBinary('x' + '\x00'.repeat(50)), true);
});

test('asMarkdown never invents structure', () => {
  assert.equal(asMarkdown('no heading here'), null);
  assert.equal(asMarkdown('## Heading\nbody'), '## Heading\nbody');
});

test('htmlToMarkdown strips inline markup inside headings and decodes entities', () => {
  assert.match(htmlToMarkdown('<h2>R&amp;D <strong>plan</strong></h2>'), /^## R&D plan/);
});

test('low-ratio control bytes are SANITISED, not rejected — good text is never thrown away', async () => {
  // Measured reality: docling occasionally emits stray C0 bytes inside otherwise-good text
  // (0.1-2.5%). Rejecting those documents would lose real content; indexing them poisons search.
  const noisy = `Solvis Umbausatz kostet 13.050 EUR\u0001 netto und die Teillast betraegt 3,7 kW.`;
  const r = await normalize(Buffer.from(noisy, 'utf-8'), { filename: 'a.txt' });
  assert.equal(r.ok, true, 'a few control bytes must not fail the document');
  assert.equal(/[\u0001-\u0008]/.test(r.text), false, 'control bytes must be stripped from the text');
  assert.match(r.text, /13\.050 EUR netto/, 'the real content survives intact');
});

test('sanitizeText keeps tab/newline/CR because the chunker reads them as structure', () => {
  const out = sanitizeText('a\tb\nc\r\n\u0000\u0007d');
  assert.equal(out, 'a\tb\nc\r\nd');
});

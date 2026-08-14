import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../../src/knowledge/document-chunker.js';
import {
  completeChunkMarkdown,
  estimateFactBearingSentences,
  LLM_PROFILES,
  llmProfile,
} from '../../src/knowledge/document-first-ingestion.js';
import { splitFastPdfPageBlocks } from '../../src/knowledge/enterprise/fast-pdf-parser.js';

// A 3-section markdown doc with facts spread across sections (shape of the
// 2026-08-05 live repro: segment 1 began "val from Martina Berger").
const DOC = [
  '# Q3 Field Report — Nordwind Energie',
  '',
  '## Overview',
  'Nordwind Energie GmbH signed the Wartungsvertrag on 2026-06-15. The contract covers 14 turbines of type E3DC-S10E across the Hannover region. The agreed service window is 48 hours, with a penalty of 1.240 EUR per day of delay.',
  '',
  '## Pricing',
  'The annual maintenance price is 38.500 EUR per turbine. Spare parts above 500 EUR require approval from Martina Berger, the operations lead. The r290 coolant retrofit is scheduled for Phase 2, starting April 2027.',
  '',
  '## Open Items',
  'The grid connection audit for site HV-221 is still pending. Ladesäulen integration tests failed twice in July; retest is planned with Teillastbetrieb scenarios. Contact: Marco Silva (marco.silva@nordwind.example).',
].join('\n');

test('overlap never starts a chunk mid-word', () => {
  const chunks = chunkText(DOC, { targetSize: 700, maxSize: 1050, minSize: 200, overlapSize: 120 });
  assert.ok(chunks.length >= 2, 'expected the doc to split');
  for (const c of chunks.slice(1)) {
    const first = c.text.charAt(0);
    // A chunk continuing prose must begin at a word start: uppercase, digit, or a
    // full lowercase word (>=4 chars before space) — never a 1-3 char fragment
    // like "val" sliced out of "approval".
    if (/^[a-z]/.test(first)) {
      const word = c.text.split(/\s/, 1)[0];
      assert.ok(word.length >= 4, `chunk starts mid-word: ${JSON.stringify(c.text.slice(0, 30))}`);
    }
  }
});

test('overlap does not lose content (union covers the doc)', () => {
  const chunks = chunkText(DOC, { targetSize: 700, maxSize: 1050, minSize: 200, overlapSize: 120 });
  const joined = chunks.map((c) => c.text).join('\n');
  for (const probe of ['Wartungsvertrag', '38.500', 'Martina Berger', 'HV-221', 'Marco Silva']) {
    assert.ok(joined.includes(probe), `lost content: ${probe}`);
  }
});

test('fact-bearing estimator counts dense sentences, not chars', () => {
  const est = estimateFactBearingSentences(DOC);
  assert.ok(est.factBearing >= 8, `expected >=8 fact-bearing sentences, got ${est.factBearing}`);
  const sparse = estimateFactBearingSentences('the wind blows. the sky is blue. it is nice.');
  assert.ok(sparse.factBearing <= 1, `sparse text over-estimated: ${sparse.factBearing}`);
});

test('claim-structuring budget is reachable: batch cap fits under the token ceiling', () => {
  const prof = LLM_PROFILES['v5-claim-structuring'];
  const batchMax = Number(process.env.CLAIM_STRUCTURING_BATCH_MAX || 17);
  const budget = typeof prof.maxTokens === 'function' ? prof.maxTokens(batchMax) : prof.maxTokens;
  assert.ok(budget <= 8000, `batch of ${batchMax} exceeds the 8000 cap (budget=${budget}) — guaranteed truncation`);
  // deepseek measured ~300-350 tokens/claim; the budget must hold that.
  assert.ok(budget >= batchMax * 350, `budget ${budget} under deepseek verbosity for n=${batchMax}`);
});

test('llmProfile throws on unknown feature (no silent default budget)', () => {
  assert.throws(() => llmProfile('nope-not-a-feature'), /no profile/);
});

test('fast-pdf page splitting retains page one when the first marker is page two', () => {
  const pageOne = `Course registration\n${'Module A instructor and assessment details. '.repeat(24)}`;
  const pageTwo = `Advanced Photonics\n${'Module B instructor and examination details. '.repeat(10)}`;
  const blocks = splitFastPdfPageBlocks(`${pageOne}\n-- 2 of 2 --\n${pageTwo}`);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].page, 1);
  assert.equal(blocks[1].page, 2);
  assert.match(blocks[0].text, /Module A instructor/);
  assert.match(blocks[1].text, /Advanced Photonics/);
});

test('partial hybrid chunks cannot replace complete parser text', () => {
  const firstPage = `Course registration page one. ${'Required course information. '.repeat(45)}`;
  const lastPage = `Advanced Photonics page two. ${'Signature field. '.repeat(8)}`;
  const result = completeChunkMarkdown(`${firstPage}\n${lastPage}`, [
    { text: lastPage, headings: ['Advanced Photonics'], page: 2 },
  ]);

  assert.ok(result.coverage < 0.5, `expected visibly partial coverage, got ${result.coverage}`);
  assert.equal(result.markdown, null);
});

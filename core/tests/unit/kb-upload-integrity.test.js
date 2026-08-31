import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chunkText } from '../../src/knowledge/document-chunker.js';
import {
  completeChunkMarkdown,
  estimateFactBearingSentences,
  atomizeUnifiedFacts,
  LLM_PROFILES,
  llmProfile,
} from '../../src/knowledge/document-first-ingestion.js';
import {
  assessTextLayerQuality,
  chunkTextAtSemanticBoundaries,
  splitFastPdfPageBlocks,
} from '../../src/knowledge/enterprise/fast-pdf-parser.js';
import { visionProviderAvailable } from '../../src/knowledge/enterprise/groq-vision-parser.js';

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

test('PDF quality gate rejects the measured fragmented OCR text shape', () => {
  const damaged = 'Ar t D ir e c t or Willia m S q u a r e Wr it e r Carol Conn '.repeat(80);
  const clean = 'The annual report identifies William Square as art director and Carol Conn as writer. '.repeat(80);
  const bad = assessTextLayerQuality(damaged);
  const good = assessTextLayerQuality(clean);
  assert.equal(bad.corrupt, true, JSON.stringify(bad));
  assert.equal(good.corrupt, false, JSON.stringify(good));
  assert.ok(bad.singleRatio > good.singleRatio);
});

test('vision OCR accepts direct Cloudflare Gemini transport without OpenRouter', () => {
  const names = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_AI_GATEWAY_ID',
    'CLOUDFLARE_AI_GATEWAY_TOKEN'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    CLOUDFLARE_AI_GATEWAY_ID: 'test-gateway',
    CLOUDFLARE_AI_GATEWAY_TOKEN: 'test-token',
  });
  try { assert.equal(visionProviderAvailable(), true); }
  finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('fast PDF page chunks use semantic boundaries and never bisect words', () => {
  const source = [
    'Executive summary explains the complete operating model and its constraints.',
    'The annual report names the accountable owners and preserves every measured value.',
    'A final paragraph records the decision, date, scope, rationale, and expected outcome.',
  ].join(' ').concat(' ').repeat(35).trim();
  const chunks = chunkTextAtSemanticBoundaries(source, 600, 90);
  assert.ok(chunks.length > 3);
  for (const chunk of chunks) {
    assert.match(chunk, /^[A-Za-z]/);
    assert.match(chunk, /[A-Za-z.]$/);
  }
  for (const probe of ['Executive summary', 'accountable owners', 'expected outcome']) {
    assert.ok(chunks.some((chunk) => chunk.includes(probe)), `lost ${probe}`);
  }
});

test('canonical atomicity operates on the schema f field', () => {
  const [one, two, three] = [
    'Northwind approved the plan.',
    'The budget is 40,000 EUR.',
    'Delivery begins in October.',
  ];
  const split = atomizeUnifiedFacts([{ f: `${one} ${two} ${three}`, source_quote: `${one} ${two} ${three}` }]);
  assert.deepEqual(split.map((fact) => fact.f), [one, two, three]);
  assert.ok(split.every((fact) => fact._atomized));
});

test('canonical generation prompt stays source-grounded and metadata-aware', () => {
  const source = readFileSync(new URL('../../src/knowledge/document-first-ingestion.js', import.meta.url), 'utf8');
  for (const contract of [
    'Every source_quote must be one exact contiguous substring from SECTION',
    'Preserve exact names, dates, quantities, units, categorical nouns, negation and uncertainty',
    'Relationships are structured claim metadata only and must be explicitly supported by the same source_quote',
    'do not invent causal or organizational links',
    'Never emit source filenames, document titles, file extensions',
  ]) {
    assert.ok(source.includes(contract), `canonical prompt lost contract: ${contract}`);
  }
});

test('stored promotion preserves the existing evidence-only reason contract', () => {
  const source = readFileSync(new URL('../../src/knowledge/document-first-ingestion.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /memory_generation_yield_zero/);
  assert.match(source, /evidenceOnlyReason: memories\.length \? null : 'extraction_yield_zero'/);
});

test('entity and relationship prompt keeps graph-memory semantic contracts', () => {
  const source = readFileSync(new URL('../../src/memory/graph-engine.js', import.meta.url), 'utf8');
  for (const contract of [
    'extract ALL materially useful, source-supported entities',
    'Do not stop after the first or most obvious entity',
    'Updates the earlier preference',
    'Extends (additive, no',
    'Derives from both',
    'two memories mentioning the same person but unrelated facts → Mentions only',
    'never infer the mechanism from co-occurrence alone',
  ]) {
    assert.ok(source.includes(contract), `graph prompt lost contract: ${contract}`);
  }
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

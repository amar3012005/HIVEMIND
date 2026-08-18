import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTrigramFallbackForms,
  buildWideTsQuery,
  lexicalQueryTokens,
  shouldRunTrigramFallback,
} from '../../src/memory/lexical-query.js';

test('managed lexical query preserves multilingual letters and numeric identifiers', () => {
  assert.deepEqual(
    lexicalQueryTokens('¿Cuál es el periodo de retención 2021?'),
    ['cuál', 'es', 'el', 'periodo', 'de', 'retención', '2021'],
  );
  assert.deepEqual(
    lexicalQueryTokens('ما هو رمز العقد ٩٨٧٦؟'),
    ['ما', 'هو', 'رمز', 'العقد', '٩٨٧٦'],
  );
  assert.equal(buildWideTsQuery('رمز العقد ٩٨٧٦'), 'رمز:* | العقد:* | ٩٨٧٦:*');
});

test('managed lexical lane is recall-oriented OR, not filler-sensitive AND', () => {
  const query = buildWideTsQuery('What is the exact SolvisLea launch date?');
  assert.match(query, /solvislea:\*/);
  assert.match(query, /launch:\*/);
  assert.equal(query.includes(' & '), false);
  assert.equal(query.includes(' | '), true);
});

test('trigram fallback does not synthesize conversational adjacent pairs', () => {
  assert.deepEqual(
    buildTrigramFallbackForms('what all solvis products do we have?'),
    ['solvis', 'products'],
  );
  assert.deepEqual(
    buildTrigramFallbackForms('Solvis Tim'),
    ['solvistim', 'solvis'],
  );
  assert.deepEqual(buildTrigramFallbackForms('contrct'), ['contrct']);
});

test('trigram fallback is gated to a genuinely sparse indexed FTS result', () => {
  const base = { enabled: true, forms: ['solvistim'], requested: 150, threshold: 12 };
  assert.equal(shouldRunTrigramFallback({ ...base, ftsCount: 150 }), false);
  assert.equal(shouldRunTrigramFallback({ ...base, ftsCount: 12 }), false);
  assert.equal(shouldRunTrigramFallback({ ...base, ftsCount: 11 }), true);
  assert.equal(shouldRunTrigramFallback({ ...base, enabled: false, ftsCount: 0 }), false);
  assert.equal(shouldRunTrigramFallback({ ...base, forms: [], ftsCount: 0 }), false);
});

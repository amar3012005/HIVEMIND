import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWideTsQuery, lexicalQueryTokens } from '../../src/memory/lexical-query.js';

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

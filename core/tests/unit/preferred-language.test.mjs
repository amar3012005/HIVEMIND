import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePreferredLanguage,
  narrativeLanguageInstruction,
} from '../../src/hyper/preferred-language.js';

test('preferred language defaults to English and rejects unknown codes', () => {
  assert.equal(normalizePreferredLanguage(undefined), 'en');
  assert.equal(normalizePreferredLanguage(''), 'en');
  assert.equal(normalizePreferredLanguage('DE-de'), 'de');
  assert.equal(normalizePreferredLanguage('zz'), 'en');
});

test('narrative instruction keeps JSON keys English', () => {
  assert.match(narrativeLanguageInstruction('en'), /English only/u);
  assert.match(narrativeLanguageInstruction('de'), /preferred language \(de\)/u);
  assert.match(narrativeLanguageInstruction('de'), /JSON object keys stay English/u);
});

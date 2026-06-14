import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEntity, normalizeEntityTag, normalizeTagsArray } from '../../src/memory/entity-normalize.js';

test('case variants collapse', () => {
  assert.equal(normalizeEntity('SOLVIS'), 'solvis');
  assert.equal(normalizeEntity('Solvis'), 'solvis');
  assert.equal(normalizeEntity('solvis'), 'solvis');
});

test('legal suffix stripped → company variants merge', () => {
  assert.equal(normalizeEntity('SOLVIS_GmbH'), 'solvis');
  assert.equal(normalizeEntity('Solvis GmbH'), 'solvis');
  assert.equal(normalizeEntity('Acme Inc.'), 'acme');
  assert.equal(normalizeEntity('Foo Holding'), 'foo');
});

test('unicode hyphen + underscore variants of a product all converge', () => {
  const a = normalizeEntity('SolvisControl-3');     // ascii hyphen
  const b = normalizeEntity('SolvisControl‑3'); // unicode non-breaking hyphen
  const c = normalizeEntity('SolvisControl_3');      // underscore
  assert.equal(a, 'solviscontrol-3');
  assert.equal(b, 'solviscontrol-3');
  assert.equal(c, 'solviscontrol-3');
});

test('SKU qualifiers stay DISTINCT (no false-merge)', () => {
  assert.notEqual(normalizeEntity('SolvisBruno_7_kW'), normalizeEntity('SolvisBruno_10_kW'));
  assert.equal(normalizeEntity('SolvisBruno_7_kW'), 'solvisbruno-7-kw');
  assert.equal(normalizeEntity('SolvisBruno_10_kW'), 'solvisbruno-10-kw');
});

test('distinct entities are NOT merged', () => {
  assert.notEqual(normalizeEntity('SolvisBruno'), normalizeEntity('SolvisLino'));
  assert.notEqual(normalizeEntity('Markus Kube'), normalizeEntity('Gabriele Münzer'));
});

test('mechanical only — NO hardcoded cross-lingual/semantic merge', () => {
  // Cross-lingual + singular/plural + abbreviation canonicalization is the
  // LLM extractor's job (strict prompt rules), NOT a curated dictionary here.
  // This layer must NOT translate or remap — only fold surface-form noise.
  assert.equal(normalizeEntity('Wärmepumpe'), 'wärmepumpe');      // umlaut preserved, NOT → heat-pump
  assert.equal(normalizeEntity('heat_pump'), 'heat-pump');         // underscore→space→slug (mechanical)
  assert.equal(normalizeEntity('Photovoltaik'), 'photovoltaik');   // NOT → photovoltaic
  assert.equal(normalizeEntity('heat pumps'), 'heat-pumps');       // plural NOT singularized here
});

test('umlauts preserved in non-synonym names', () => {
  assert.equal(normalizeEntity('Gabriele Münzer'), 'gabriele-münzer');
});

test('normalizeEntityTag: only entity: tags touched', () => {
  assert.equal(normalizeEntityTag('entity:SOLVIS_GmbH'), 'entity:solvis');
  assert.equal(normalizeEntityTag('topic:company'), 'topic:company');
  assert.equal(normalizeEntityTag('filename:X.pdf'), 'filename:X.pdf');
  assert.equal(normalizeEntityTag('ts:2026-06-14'), 'ts:2026-06-14');
});

test('normalizeTagsArray collapses dup entity tags, preserves others + order', () => {
  const out = normalizeTagsArray(['entity:SOLVIS', 'topic:company', 'entity:Solvis', 'entity:SOLVIS_GmbH', 'filename:a.pdf']);
  assert.deepEqual(out, ['entity:solvis', 'topic:company', 'filename:a.pdf']);
});

test('garbage / empty input', () => {
  assert.equal(normalizeEntity(''), null);
  assert.equal(normalizeEntity('   '), null);
  assert.equal(normalizeEntity(null), null);
  assert.equal(normalizeEntityTag('entity:'), 'entity:'); // unchanged when nothing to normalize
});

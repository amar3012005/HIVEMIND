/**
 * entity-normalize-integration.test.js
 *
 * Integration-level assertions for the ingest->tag canonicalization path.
 *
 * Scope: simulates the full fragmentation class collapse that the co-mention
 * LLM produces. No DB, no network, no mocks — only the pure normalizer
 * functions and deterministic Set arithmetic.
 *
 * Does NOT duplicate the low-level unit cases that already live in
 * entity-normalize.test.js. These tests operate one level up: given a
 * realistic list of raw LLM entity names (as they appear in `entity:<Name>`
 * tags), assert that the deduplication outcome across a whole set of names
 * is correct, i.e. the canonical tag count equals the expected distinct
 * concept count.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEntityTag,
  normalizeTagsArray,
} from '../../src/memory/entity-normalize.js';

// ---------------------------------------------------------------------------
// Helper: map a list of raw entity names (no prefix) through normalizeEntityTag
// and return the Set of canonical tag strings.
// ---------------------------------------------------------------------------
function tagSet(rawNames) {
  const tags = rawNames.map(n => normalizeEntityTag(`entity:${n}`));
  return new Set(tags);
}

// ---------------------------------------------------------------------------
// Class 1 — company name variants
// SOLVIS / Solvis / SOLVIS_GmbH / SOLVIS GmbH → all collapse to entity:solvis
// ---------------------------------------------------------------------------
test('SOLVIS company variants all collapse to one canonical entity tag', () => {
  const inputs = ['SOLVIS', 'Solvis', 'SOLVIS_GmbH', 'SOLVIS GmbH'];
  const canonical = tagSet(inputs);

  assert.equal(
    canonical.size,
    1,
    `expected 1 distinct canonical tag, got ${canonical.size}: ${[...canonical].join(', ')}`,
  );
  assert.ok(
    canonical.has('entity:solvis'),
    `canonical set should contain entity:solvis, got: ${[...canonical].join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// Class 2 — product with unicode hyphen variants
// SolvisControl-3 / SolvisControl‑3 (U+2011) / SolvisControl_3 → entity:solviscontrol-3
// ---------------------------------------------------------------------------
test('SolvisControl-3 unicode-hyphen and underscore variants collapse to one canonical entity tag', () => {
  // U+2011 NON-BREAKING HYPHEN embedded in the string literal below:
  const inputs = [
    'SolvisControl-3',   // ASCII hyphen 0x2D
    'SolvisControl‑3', // NON-BREAKING HYPHEN U+2011
    'SolvisControl_3',   // underscore
  ];
  const canonical = tagSet(inputs);

  assert.equal(
    canonical.size,
    1,
    `expected 1 distinct canonical tag, got ${canonical.size}: ${[...canonical].join(', ')}`,
  );
  assert.ok(
    canonical.has('entity:solviscontrol-3'),
    `canonical set should contain entity:solviscontrol-3, got: ${[...canonical].join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// Class 3 — SKU discriminators MUST stay DISTINCT
// SolvisBruno_7_kW and SolvisBruno_10_kW differ by power rating — they are
// different products and must NOT be false-merged.
// ---------------------------------------------------------------------------
test('SKU variants with different power ratings remain distinct canonical entity tags', () => {
  const inputs = ['SolvisBruno_7_kW', 'SolvisBruno_10_kW'];
  const canonical = tagSet(inputs);

  assert.equal(
    canonical.size,
    2,
    `expected 2 distinct canonical tags (different SKUs), got ${canonical.size}: ${[...canonical].join(', ')}`,
  );
  assert.ok(
    canonical.has('entity:solvisbruno-7-kw'),
    `canonical set should contain entity:solvisbruno-7-kw`,
  );
  assert.ok(
    canonical.has('entity:solvisbruno-10-kw'),
    `canonical set should contain entity:solvisbruno-10-kw`,
  );
});

// ---------------------------------------------------------------------------
// Class 4 — cross-lingual is NOT merged mechanically (it's the LLM's job).
// The deterministic layer must keep distinct surface forms distinct; only the
// extractor LLM (strict prompt) emits one canonical name per concept. Encoding
// DE↔EN pairs here would be domain-specific hardcoding that never generalizes.
// ---------------------------------------------------------------------------
test('cross-lingual variants are NOT merged by the mechanical layer', () => {
  const canonical = tagSet(['Wärmepumpe', 'heat pump']);
  assert.equal(
    canonical.size,
    2,
    `mechanical layer must not translate; expected 2 distinct tags, got ${[...canonical].join(', ')}`,
  );
  assert.ok(canonical.has('entity:wärmepumpe'));
  assert.ok(canonical.has('entity:heat-pump'));
});

// ---------------------------------------------------------------------------
// Class 5 — mixed tags array: dup entity tags + non-entity tags
// normalizeTagsArray must:
//   • deduplicate entity: tags after canonicalization
//   • pass non-entity tags through unchanged
//   • preserve first-occurrence order
// ---------------------------------------------------------------------------
test('normalizeTagsArray deduplicates entity tags and preserves non-entity tag order', () => {
  const input = [
    'entity:SOLVIS',        // first occurrence of the solvis canonical
    'topic:heating',        // non-entity — preserve
    'entity:Solvis',        // dup after normalize → dropped
    'entity:SOLVIS_GmbH',   // dup after normalize → dropped
    'filename:manual.pdf',  // non-entity — preserve, after the entity dupes
    'entity:SolvisControl_3', // new distinct entity
    'entity:SolvisControl-3', // dup of the above → dropped
  ];

  const output = normalizeTagsArray(input);

  // Expected: first-occurrence order, dupes removed
  assert.deepEqual(output, [
    'entity:solvis',
    'topic:heating',
    'filename:manual.pdf',
    'entity:solviscontrol-3',
  ]);
});

// ---------------------------------------------------------------------------
// Class 5b — edge case: empty and null-ish inputs to normalizeTagsArray
// ---------------------------------------------------------------------------
test('normalizeTagsArray returns empty array for empty input', () => {
  assert.deepEqual(normalizeTagsArray([]), []);
});

test('normalizeTagsArray passes through non-array input unchanged', () => {
  // The production code guards: `if (!Array.isArray(tags)) return tags`
  assert.equal(normalizeTagsArray(null), null);
  assert.equal(normalizeTagsArray(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Class 6 — entity: tag with empty payload stays unchanged (regression guard)
// normalizeEntityTag('entity:') must not throw and must return original tag
// ---------------------------------------------------------------------------
test('normalizeEntityTag with empty entity payload returns original tag unchanged', () => {
  assert.equal(normalizeEntityTag('entity:'), 'entity:');
});

// ---------------------------------------------------------------------------
// Class 7 — non-entity tags of all common prefix families pass through intact
// ---------------------------------------------------------------------------
test('non-entity tag prefixes pass through normalizeEntityTag unchanged', () => {
  const nonEntityTags = [
    'topic:heating',
    'filename:SOLVIS_manual.pdf',
    'ts:2026-06-14',
    'project:my-project',
    'source:gmail',
    'tier:organization',
  ];
  for (const tag of nonEntityTags) {
    assert.equal(
      normalizeEntityTag(tag),
      tag,
      `expected tag '${tag}' to pass through unchanged`,
    );
  }
});

// ---------------------------------------------------------------------------
// Class 8 — abbreviation / synonym expansion is NOT done mechanically either.
// The LLM extractor prefers the full canonical term ("photovoltaic" over "PV");
// the deterministic layer just slugs whatever surface form it is given.
// ---------------------------------------------------------------------------
test('abbreviation and full term stay distinct in the mechanical layer', () => {
  const canonical = tagSet(['PV', 'Photovoltaik', 'photovoltaic']);
  // PV → 'pv', Photovoltaik → 'photovoltaik', photovoltaic → 'photovoltaic' — all distinct.
  assert.equal(canonical.size, 3, `expected 3 distinct tags, got ${[...canonical].join(', ')}`);
  assert.ok(canonical.has('entity:pv'));
  assert.ok(canonical.has('entity:photovoltaik'));
  assert.ok(canonical.has('entity:photovoltaic'));
});

// ---------------------------------------------------------------------------
// Class 9 — legal suffix variants for common suffixes beyond GmbH
// Acme Inc / Acme LLC / Acme Corp / Acme → all entity:acme
// ---------------------------------------------------------------------------
test('legal suffix variants for a generic company name collapse to one canonical entity tag', () => {
  const inputs = ['Acme Inc', 'Acme LLC', 'Acme Corp', 'Acme', 'Acme Inc.', 'ACME_Inc'];
  const canonical = tagSet(inputs);

  assert.equal(
    canonical.size,
    1,
    `expected 1 canonical tag for Acme variants, got ${canonical.size}: ${[...canonical].join(', ')}`,
  );
  assert.ok(
    canonical.has('entity:acme'),
    `canonical set should contain entity:acme, got: ${[...canonical].join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// Class 10 — realistic mixed ingest from two memories about the same company
// Models what happens when memory A has ['entity:SOLVIS','entity:SolvisLino_25_kW']
// and memory B has ['entity:Solvis GmbH','entity:SolvisLino_25_kW','topic:heating']
// After normalizeTagsArray on the merged tags the union should yield 3 distinct entries.
// ---------------------------------------------------------------------------
test('merged tags from two memories about same company deduplicate correctly', () => {
  const memoryATags = [
    'entity:SOLVIS',
    'entity:SolvisLino_25_kW',
    'topic:pellet-heating',
  ];
  const memoryBTags = [
    'entity:Solvis GmbH',
    'entity:SolvisLino_25_kW',
    'topic:heating',
  ];

  // Simulate merging tags as would happen in a cross-memory context
  const merged = normalizeTagsArray([...memoryATags, ...memoryBTags]);

  // SOLVIS / Solvis GmbH → one entity:solvis
  // SolvisLino_25_kW → one entity:solvinolino-25-kw (no dup)
  // topic:pellet-heating preserved
  // topic:heating preserved (distinct from pellet-heating)
  const entityTags = merged.filter(t => t.startsWith('entity:'));
  const topicTags = merged.filter(t => t.startsWith('topic:'));

  assert.equal(
    entityTags.filter(t => t === 'entity:solvis').length,
    1,
    'entity:solvis should appear exactly once after merge',
  );
  assert.equal(
    entityTags.filter(t => t.includes('solvis') && t !== 'entity:solvis').length,
    1,
    'SolvisLino tag should appear exactly once after merge',
  );
  assert.equal(topicTags.length, 2, 'two distinct topic tags should be preserved');
});

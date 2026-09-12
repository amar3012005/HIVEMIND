import test from 'node:test';
import assert from 'node:assert/strict';
import { rankEntityMatches } from '../../src/memory/entity-discovery.js';

const ENTITIES = [
  { id: '2', canonicalName: 'Uwe Berger', entityType: 'person', aliases: ['Uwe'], mentionCount: 4, lastSeenAt: '2026-09-10T00:00:00Z' },
  { id: '1', canonicalName: 'Uwe Bross', entityType: 'person', aliases: [], mentionCount: 10, lastSeenAt: '2026-09-11T00:00:00Z' },
  { id: '3', canonicalName: 'Uwe GmbH', entityType: 'organization', aliases: [], mentionCount: 12, lastSeenAt: '2026-09-12T00:00:00Z' },
];

test('entity finder returns deterministic prefix matches without a vector query', () => {
  const matches = rankEntityMatches(ENTITIES, 'Uwe', 12);
  assert.deepEqual(matches.map((match) => match.canonical_name), ['Uwe Berger', 'Uwe GmbH', 'Uwe Bross']);
  assert.ok(matches.every((match) => match.match === 'canonical_prefix' || match.match === 'alias_exact'));
});

test('entity finder gives exact aliases priority over prefix matches', () => {
  const matches = rankEntityMatches(ENTITIES, 'Uwe', 12);
  assert.equal(matches.find((match) => match.canonical_name === 'Uwe Berger').match, 'alias_exact');
  assert.equal(matches[0].canonical_name, 'Uwe Berger');
});

test('entity finder caps output and exposes only safe discovery fields', () => {
  const match = rankEntityMatches(ENTITIES, 'Bross', 1)[0];
  assert.deepEqual(Object.keys(match).sort(), ['aliases', 'canonical_name', 'entity_id', 'entity_type', 'last_seen_at', 'match', 'mention_count']);
});

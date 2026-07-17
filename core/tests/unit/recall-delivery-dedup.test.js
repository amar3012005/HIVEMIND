import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeMemoriesById } from '../../src/memory/recall-dedup.js';

test('keeps only the highest-ranked occurrence of each delivered memory', () => {
  const ranked = [
    { id: 'a', score: 0.9 },
    { memory: { id: 'a' }, score: 0.8 },
    { id: 'b', score: 0.7 },
    { id: 'b', score: 0.6 },
    { title: 'evidence-only row' },
  ];

  assert.deepEqual(dedupeMemoriesById(ranked), [ranked[0], ranked[2], ranked[4]]);
});

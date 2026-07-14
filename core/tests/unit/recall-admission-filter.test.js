import test from 'node:test';
import assert from 'node:assert/strict';
import { filterLowSaliencePromotedMemories } from '../../src/memory/recall-router.js';

const promoted = (memory_type, importance_score) => ({
  memory_type,
  importance_score,
  tags: ['promoted-memory', 'distilled-from-kb'],
});

test('filters legacy low-salience durable KB promotions', () => {
  const useful = { id: 'useful', ...promoted('decision', 0.9) };
  const noise = { id: 'noise', ...promoted('fact', 0.3) };
  assert.deepEqual(filterLowSaliencePromotedMemories([noise, useful], 0.65), [useful]);
});

test('preserves summaries, syntheses, raw memories, and admitted durable claims', () => {
  const rows = [
    { id: 'summary', ...promoted('summary', 0.45) },
    { id: 'synthesis', ...promoted('synthesis', 0.4) },
    { id: 'manual', memory_type: 'fact', importance_score: 0.2, tags: ['source:manual'] },
    { id: 'admitted', ...promoted('fact', 0.65) },
  ];
  assert.deepEqual(filterLowSaliencePromotedMemories(rows, 0.65), rows);
});

test('fails closed when a promoted durable claim has no valid importance', () => {
  assert.deepEqual(filterLowSaliencePromotedMemories([promoted('fact', null)], 0.65), []);
});

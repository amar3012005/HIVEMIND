import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterLowSaliencePromotedMemories,
  mergePromotionImportance,
} from '../../src/memory/recall-router.js';

const promoted = (memory_type, importance_score) => ({
  memory_type,
  importance_score,
  tags: ['promoted-memory', 'distilled-from-kb'],
});

test('filters legacy low-salience durable KB promotions', () => {
  const useful = { id: 'useful', ...promoted('decision', 0.9) };
  const noise = { id: 'noise', memory_type: 'fact', importance_score: 0.3, tags: ['distilled-from-kb'] };
  assert.deepEqual(filterLowSaliencePromotedMemories([noise, useful], 0.65), [useful]);
});

test('filters legacy structured-source rows even when old importance is inflated', () => {
  const css = {
    id: 'css', memory_type: 'fact', importance_score: 1,
    content: '.blue{color:var(--blue-deep);}', tags: ['distilled-from-kb'],
  };
  assert.deepEqual(filterLowSaliencePromotedMemories([css], 0.65), []);
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

test('rejects legacy conversation promotions while preserving conversation source rows', () => {
  const promotedConversation = { id: 'old-chat', ...promoted('conversation', 0.95) };
  const sourceConversation = { id: 'source-chat', memory_type: 'conversation', tags: ['source:chat'] };
  assert.deepEqual(filterLowSaliencePromotedMemories([promotedConversation, sourceConversation], 0.65), [sourceConversation]);
});

test('hydrates importance lost by lexical retrieval before admission filtering', () => {
  const memories = [{ id: 'legacy', memory_type: 'fact', tags: ['promoted-memory', 'distilled-from-kb'] }];
  const hydrated = mergePromotionImportance(memories, [{ id: 'legacy', importanceScore: 0.3 }]);
  assert.equal(hydrated[0].importance_score, 0.3);
  assert.deepEqual(filterLowSaliencePromotedMemories(hydrated, 0.65), []);
});

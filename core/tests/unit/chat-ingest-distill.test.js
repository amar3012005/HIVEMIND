import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDistillActions } from '../../src/services/chat-ingest-actions.js';

const candidates = [{ content: 'A' }, { content: 'B' }];
const neighbors = [[{ id: 'known-1' }], []];

test('chat distillation fails closed when model output is missing', () => {
  const actions = resolveDistillActions([], candidates, neighbors);
  assert.equal(actions.get(0).action, 'skip');
  assert.equal(actions.get(1).action, 'skip');
});

test('chat distillation rejects invented update targets', () => {
  const actions = resolveDistillActions([
    { index: 0, action: 'update', target_memory_id: 'invented' },
  ], candidates, neighbors);
  assert.equal(actions.get(0).action, 'skip');
  assert.equal(actions.get(0).reason, 'invalid update target');
});

test('chat distillation accepts only a retrieved update target', () => {
  const actions = resolveDistillActions([
    { index: 0, action: 'update', target_memory_id: 'known-1', reason: 'Changed' },
  ], candidates, neighbors);
  assert.deepEqual(actions.get(0), {
    index: 0,
    action: 'update',
    target_memory_id: 'known-1',
    reason: 'Changed',
  });
});

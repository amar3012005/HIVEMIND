import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onlyGrounded } from '../../src/knowledge/meeting-intelligence.js';

test('onlyGrounded keeps lines with a memory id, drops the rest', () => {
  const items = [
    { brief: 'has id', memory_ids: ['abc'] },
    { brief: 'empty ids', memory_ids: [] },
    { brief: 'no ids field' },
    { brief: 'single id', memory_id: 'xyz' },
  ];
  const kept = onlyGrounded(items);
  assert.deepEqual(kept.map((i) => i.brief), ['has id', 'single id']);
});

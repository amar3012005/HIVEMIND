import test from 'node:test';
import assert from 'node:assert/strict';

import { updateMemorySchema, validateCreateMemory } from '../src/api/validators/memory.validators.js';

test('memory create accepts an explicit validity interval', () => {
  const result = validateCreateMemory({
    user_id: '11111111-1111-4111-8111-111111111111',
    org_id: '22222222-2222-4222-8222-222222222222',
    content: 'A temporally grounded fact.',
    valid_from: '2024-01-01T00:00:00.000Z',
    valid_to: '2025-01-01T00:00:00.000Z',
  });
  assert.equal(result.success, true);
  assert.equal(result.data.valid_from, '2024-01-01T00:00:00.000Z');
  assert.equal(result.data.valid_to, '2025-01-01T00:00:00.000Z');
});

test('memory update preserves valid_to instead of silently stripping it', () => {
  const result = updateMemorySchema.safeParse({ valid_to: '2025-01-01T00:00:00.000Z' });
  assert.equal(result.success, true);
  assert.equal(result.data.valid_to, '2025-01-01T00:00:00.000Z');
});

test('memory validity fields reject ambiguous non-ISO timestamps', () => {
  assert.equal(updateMemorySchema.safeParse({ valid_to: 'next Friday' }).success, false);
});

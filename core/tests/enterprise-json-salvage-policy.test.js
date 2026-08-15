import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSalvageTruncatedJson } from '../src/knowledge/enterprise/litellm-client.js';

test('partial JSON salvage is reserved for provider-confirmed output truncation', () => {
  assert.equal(shouldSalvageTruncatedJson('length'), true);
  assert.equal(shouldSalvageTruncatedJson('stop'), false);
  assert.equal(shouldSalvageTruncatedJson(undefined), false);
});

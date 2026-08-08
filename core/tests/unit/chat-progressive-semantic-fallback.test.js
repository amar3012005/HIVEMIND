import test from 'node:test';
import assert from 'node:assert/strict';

import { adaptToDecision } from '../../src/agent/chat-progressive-router.js';

test('router clarification is grounded through recall before asking the user', () => {
  const { decision } = adaptToDecision('respond_directly', {
    response: 'Please provide more details.',
    response_language: 'de',
    reason: 'clarification',
  }, 'Welche Marke hat meine Handtasche?', 'de');

  assert.equal(decision.operation, 'recall');
  assert.deepEqual(decision.queries, ['Welche Marke hat meine Handtasche?']);
  assert.deepEqual(decision.tool_groups, ['hivemind-recall']);
  assert.equal(decision.direct_response, null);
});

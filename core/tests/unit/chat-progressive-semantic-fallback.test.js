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

test('an uncertified direct response is grounded through recall', () => {
  const { decision } = adaptToDecision('respond_directly', {
    response: 'I do not know who Kruti is.',
    response_language: 'en',
    reason: 'general',
    context_free: false,
  }, 'What do you know about Kruti?', 'en');

  assert.equal(decision.operation, 'recall');
  assert.deepEqual(decision.queries, ['What do you know about Kruti?']);
  assert.deepEqual(decision.tool_groups, ['hivemind-recall']);
});

test('a certified context-free direct response is still grounded for native chat', () => {
  const { decision } = adaptToDecision('respond_directly', {
    response: 'Hello — how can I help?',
    response_language: 'en',
    reason: 'general',
    context_free: true,
  }, 'Hello', 'en');

  assert.equal(decision.operation, 'recall');
  assert.deepEqual(decision.tool_groups, ['hivemind-recall']);
});

test('tool-enabled direct behavior remains unchanged', () => {
  const { decision } = adaptToDecision('respond_directly', {
    response: 'Hello — how can I help?', response_language: 'en',
    reason: 'general', context_free: false,
  }, 'Hello', 'en', { useTools: true });

  assert.equal(decision.operation, 'direct');
});

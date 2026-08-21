import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptToDecision,
  enforceNativeGroundingDecision,
  getProgressiveTools,
} from '../../src/agent/chat-progressive-router.js';

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

test('final native boundary grounds a direct decision produced after routing', () => {
  const { decision, overridden } = enforceNativeGroundingDecision({
    operation: 'direct',
    query_canonical_en: 'Kruti person workspace information',
    queries: [],
    tool_groups: [],
    direct_response: 'I do not know Kruti.',
    failure_response: null,
  }, 'What do you know about Kruti?', { useTools: false });

  assert.equal(overridden, true);
  assert.equal(decision.operation, 'recall');
  assert.deepEqual(decision.queries, ['Kruti person workspace information']);
  assert.deepEqual(decision.tool_groups, ['hivemind-recall']);
  assert.equal(decision.direct_response, null);
});

test('native-only planner exposes the caller-scoped profile lane without external tools', () => {
  const tools = getProgressiveTools({ useTools: false });
  const profile = tools.find((tool) => tool.function?.name === 'hivemind_profile');
  assert.ok(profile);
  assert.deepEqual(profile.function.parameters.properties.target.enum, [
    'user', 'organization', 'user_and_organization',
  ]);

  const { decision, overridden } = enforceNativeGroundingDecision({
    operation: 'profile',
    query_canonical_en: 'authenticated caller maintained profile',
    queries: [],
    tool_groups: [],
    answer_objective: 'Describe the authenticated caller from maintained profile facts.',
  }, 'What do you know about me?', { useTools: false });

  assert.equal(overridden, false);
  assert.equal(decision.operation, 'profile');
  assert.deepEqual(decision.queries, []);
});

test('final native boundary grounds even a model-labelled refusal while preserving tool mode', () => {
  const safety = enforceNativeGroundingDecision({
    operation: 'direct', failure_response: 'I cannot help with that.', queries: [],
  }, 'unsafe request', { useTools: false });
  const tools = enforceNativeGroundingDecision({
    operation: 'direct', failure_response: null, queries: [],
  }, 'Hello', { useTools: true });

  assert.equal(safety.overridden, true);
  assert.equal(safety.decision.operation, 'recall');
  assert.equal(tools.overridden, false);
  assert.equal(tools.decision.operation, 'direct');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { adaptToDecision, getProgressiveTools } from '../../src/agent/chat-progressive-router.js';

test('use_tools false never discloses connected or compound capabilities', () => {
  const names = getProgressiveTools({ useTools: false }).map((tool) => tool.function.name);
  assert.ok(names.includes('hivemind_context'));
  assert.ok(names.includes('hivemind_memory'));
  assert.equal(names.includes('use_connector'), false);
  assert.equal(names.includes('use_campaign'), false);
  assert.equal(names.includes('compound_plan'), false);
});

test('use_tools true discloses connected and compound capabilities', () => {
  const tools = getProgressiveTools({ useTools: true });
  const names = tools.map((tool) => tool.function.name);
  assert.ok(names.includes('use_connector'));
  assert.ok(names.includes('use_campaign'));
  assert.ok(names.includes('compound_plan'));
  const connector = tools.find((tool) => tool.function.name === 'use_connector');
  assert.ok(connector.function.parameters.properties.provider.enum.includes('google-calendar'));
  assert.ok(connector.function.parameters.properties.provider.enum.includes('google-tasks'));
});

test('connection-aware tools disclose only active connector providers', () => {
  const tools = getProgressiveTools({ useTools: true, connectedProviders: ['gmail', 'slack', 'unknown-provider'] });
  const connector = tools.find((tool) => tool.function.name === 'use_connector');
  assert.deepEqual(connector.function.parameters.properties.provider.enum, ['gmail', 'slack', 'unknown-provider']);
  assert.ok(tools.some((tool) => tool.function.name === 'compound_plan'));
  assert.ok(tools.some((tool) => tool.function.name === 'hivemind_context'));
});

test('connection-aware tools omit connector execution when no external account is active', () => {
  const tools = getProgressiveTools({ useTools: true, connectedProviders: [] });
  assert.equal(tools.some((tool) => tool.function.name === 'use_connector'), false);
  assert.ok(tools.some((tool) => tool.function.name === 'hivemind_context'));
});

test('a malformed connector decision is downgraded when use_tools is false', () => {
  const { decision } = adaptToDecision('use_connector', {
    provider: 'gmail', intent: 'read', request: 'recent mail', response_language: 'en',
  }, 'Find my recent email', 'en', { useTools: false });
  assert.equal(decision.operation, 'recall');
  assert.deepEqual(decision.tool_groups, ['hivemind-recall']);
});

test('connector router preserves language-independent newest retrieval semantics', () => {
  const { decision } = adaptToDecision('use_connector', {
    provider: 'gmail', intent: 'read', request: 'Worum ging es in meiner letzten E-Mail?', response_language: 'de',
    result_order: 'newest', result_limit: 1, has_explicit_filter: false,
  }, 'Worum ging es in meiner letzten E-Mail?', 'de', { useTools: true });
  assert.equal(decision.operation, 'connector_read');
  assert.deepEqual(decision.connector_retrieval, {
    result_order: 'newest', result_limit: 1, has_explicit_filter: false,
  });
});

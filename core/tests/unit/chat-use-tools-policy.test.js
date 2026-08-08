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
  const names = getProgressiveTools({ useTools: true }).map((tool) => tool.function.name);
  assert.ok(names.includes('use_connector'));
  assert.ok(names.includes('use_campaign'));
  assert.ok(names.includes('compound_plan'));
});

test('a malformed connector decision is downgraded when use_tools is false', () => {
  const { decision } = adaptToDecision('use_connector', {
    provider: 'gmail', intent: 'read', request: 'recent mail', response_language: 'en',
  }, 'Find my recent email', 'en', { useTools: false });
  assert.equal(decision.operation, 'recall');
  assert.deepEqual(decision.tool_groups, ['hivemind-recall']);
});

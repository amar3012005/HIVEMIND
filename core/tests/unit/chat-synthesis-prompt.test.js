import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSynthesisSystemPrompt } from '../../src/agent/chat-synthesis-prompt.js';

test('fact synthesis loads only the compact grounding and citation contract', () => {
  const prompt = buildSynthesisSystemPrompt({ language: 'es', operation: 'recall', recallMode: 'fact' });
  assert.match(prompt, /SPANISH/);
  assert.match(prompt, /citation_ids/);
  assert.match(prompt, /closely related grounded details/i);
  assert.match(prompt, /be more specific/i);
  assert.match(prompt, /Never collapse partial knowledge/i);
  assert.doesNotMatch(prompt, /GRAPH EDGES/i);
  assert.doesNotMatch(prompt, /TEMPORAL/i);
});

test('timeline synthesis adds temporal handling without making fact prompts temporal', () => {
  const prompt = buildSynthesisSystemPrompt({ language: 'en', operation: 'timeline', recallMode: 'explain' });
  assert.match(prompt, /TEMPORAL/);
  assert.match(prompt, /superseded/i);
});

test('operation modules are disclosed only to the matching synthesis path', () => {
  assert.match(buildSynthesisSystemPrompt({ operation: 'profile' }), /PROFILE:/);
  assert.match(buildSynthesisSystemPrompt({ operation: 'source_read' }), /SOURCE:/);
  assert.match(buildSynthesisSystemPrompt({ operation: 'connector_read' }), /LIVE CONNECTOR:/);
  assert.match(buildSynthesisSystemPrompt({ operation: 'connector_write' }), /MUTATION:/);
  assert.doesNotMatch(buildSynthesisSystemPrompt({ operation: 'recall' }), /LIVE CONNECTOR:|MUTATION:/);
});

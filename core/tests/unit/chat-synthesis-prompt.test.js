import test from 'node:test';
import assert from 'node:assert/strict';

import { appendGapClarification, buildSynthesisSystemPrompt } from '../../src/agent/chat-synthesis-prompt.js';

test('fact synthesis loads only the compact grounding and citation contract', () => {
  const prompt = buildSynthesisSystemPrompt({ language: 'es', operation: 'recall', recallMode: 'fact' });
  assert.match(prompt, /SPANISH/);
  assert.match(prompt, /citation_ids/);
  assert.match(prompt, /closely related grounded details/i);
  assert.match(prompt, /targeted clarification question/i);
  assert.match(prompt, /Never collapse partial knowledge/i);
  assert.match(prompt, /response.*must end with one natural, targeted clarification question/i);
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

test('a clarification question emitted in gaps is visible in the final response', () => {
  assert.equal(
    appendGapClarification('I found the brand G ROCHER.', ['Which label or image shows the model number?']),
    'I found the brand G ROCHER.\nWhich label or image shows the model number?',
  );
  assert.equal(
    appendGapClarification('I found the brand. Can you share the label?', ['Which model?']),
    'I found the brand. Can you share the label?',
  );
  assert.equal(
    appendGapClarification('The brand is G ROCHER.', ['Exact model number'], 'en'),
    'The brand is G ROCHER.\nCould you be more specific about “Exact model number”—for example, which image, label, document, or message should I check?',
  );
});

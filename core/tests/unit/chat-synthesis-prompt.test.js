import test from 'node:test';
import assert from 'node:assert/strict';

import { appendGapClarification, appendSuggestedFollowUps, buildSynthesisPromptArtifact, buildSynthesisSystemPrompt } from '../../src/agent/chat-synthesis-prompt.js';
import { resetStaticPromptCacheForTests } from '../../src/agent/chat-static-prompt-cache.js';

test('fact synthesis loads only the compact grounding and citation contract', () => {
  const prompt = buildSynthesisSystemPrompt({ language: 'es', operation: 'recall', recallMode: 'fact' });
  assert.match(prompt, /SPANISH/);
  assert.match(prompt, /citation_ids/);
  assert.match(prompt, /closely related grounded detail/i);
  assert.match(prompt, /living memory/i);
  assert.match(prompt, /thoughtful colleague/i);
  assert.match(prompt, /well-informed human colleague/i);
  assert.match(prompt, /one bounded fact/i);
  assert.match(prompt, /semantic breadth and the useful evidence determine length/i);
  assert.match(prompt, /default to the inside voice/i);
  assert.match(prompt, /Humanity never licenses invention/i);
  assert.match(prompt, /clarification question is appropriate only/i);
  assert.match(prompt, /Never collapse partial knowledge/i);
  assert.match(prompt, /do not invent gaps/i);
  assert.match(prompt, /every independent semantic detail/i);
  assert.match(prompt, /"coverage"/i);
  assert.match(prompt, /context_status/i);
  assert.match(prompt, /follow_ups/i);
  assert.match(prompt, /two or three concise suggested next questions/i);
  assert.match(prompt, /direct conclusion or concise summary/i);
  assert.match(prompt, /USER ASSERTION \/ UNVERIFIED/);
  assert.match(prompt, /Never claim that no record exists while one is delivered/);
  assert.doesNotMatch(prompt, /GRAPH EDGES/i);
  assert.doesNotMatch(prompt, /TEMPORAL/i);
});

test('answer objective and semantic depth shape one synthesis without encouraging drift', () => {
  const prompt = buildSynthesisSystemPrompt({
    language: 'en', operation: 'recall', recallMode: 'explain',
    responseDepth: 'detailed',
    answerObjective: 'Enumerate and describe the Solvis products supported by the evidence.',
  });
  assert.match(prompt, /ANSWER OBJECTIVE: Enumerate and describe the Solvis products/);
  assert.match(prompt, /DETAILED DEPTH/);
  assert.match(prompt, /complete delivered top-fifteen window/i);
  assert.match(prompt, /Inspect every delivered evidence item/);
  assert.match(prompt, /collect and deduplicate every distinct supported item/);
  assert.match(prompt, /multiple distinct findings/i);
  assert.match(prompt, /must never replace, obscure, or distract/);
  assert.match(prompt, /telemetry, not a request for another retrieval or synthesis pass/);
});

test('comprehensive synthesis asks for every distinct delivered finding without claiming corpus-wide completeness', () => {
  const prompt = buildSynthesisSystemPrompt({
    language: 'en', operation: 'recall', recallMode: 'explain', responseDepth: 'comprehensive',
  });
  assert.match(prompt, /COMPREHENSIVE DEPTH/);
  assert.match(prompt, /complete delivered top-fifteen window/i);
  assert.match(prompt, /every distinct supported finding/i);
  assert.match(prompt, /Do not claim completeness outside the delivered window/);
});

test('timeline synthesis adds temporal handling without making fact prompts temporal', () => {
  const prompt = buildSynthesisSystemPrompt({ language: 'en', operation: 'timeline', recallMode: 'explain' });
  assert.match(prompt, /TEMPORAL/);
  assert.match(prompt, /superseded/i);
});

test('synthesis keeps an identical cacheable prefix across language and operation changes', () => {
  resetStaticPromptCacheForTests();
  const first = buildSynthesisPromptArtifact({ language: 'en', operation: 'recall', recallMode: 'fact' });
  const second = buildSynthesisPromptArtifact({ language: 'de', operation: 'timeline', recallMode: 'timeline' });
  assert.equal(first.cache.status, 'miss');
  assert.equal(second.cache.status, 'hit');
  assert.equal(first.static_prompt, second.static_prompt);
  assert.equal(first.cache.fingerprint, second.cache.fingerprint);
  assert.match(second.dynamic_prompt, /GERMAN/);
  assert.match(second.dynamic_prompt, /TEMPORAL/);
  assert.ok(first.prompt.startsWith(first.static_prompt));
  assert.ok(second.prompt.startsWith(second.static_prompt));
  assert.deepEqual(first.messages[0], { role: 'system', content: first.static_prompt });
  assert.deepEqual(second.messages[0], { role: 'system', content: second.static_prompt });
  assert.notEqual(first.messages[1].content, second.messages[1].content);
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
    'The brand is G ROCHER.',
  );
});

test('grounded follow-up suggestions are appended in deterministic order and language', () => {
  assert.equal(
    appendSuggestedFollowUps('The answer.', ['What changed?', 'Who approved it?', 'What changed?'], 'en'),
    'The answer.\n\nSuggested follow-ups:\n- What changed?\n- Who approved it?',
  );
  assert.equal(
    appendSuggestedFollowUps('Die Antwort.', ['Was änderte sich?', 'Wer stimmte zu?'], 'de'),
    'Die Antwort.\n\nMögliche nächste Fragen:\n- Was änderte sich?\n- Wer stimmte zu?',
  );
  assert.equal(appendSuggestedFollowUps('Short.', ['Only one?'], 'en'), 'Short.');
});

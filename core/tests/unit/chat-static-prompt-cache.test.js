import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getStaticPromptArtifact,
  promptContributionTelemetry,
  resetStaticPromptCacheForTests,
} from '../../src/agent/chat-static-prompt-cache.js';

test('static prompt artifact is built once and then served from CAG', () => {
  resetStaticPromptCacheForTests();
  let builds = 0;
  const input = { family: 'test', version: 'v1', variant: 'base', build: () => { builds += 1; return 'stable prompt'; } };
  const first = getStaticPromptArtifact(input);
  const second = getStaticPromptArtifact(input);
  assert.equal(first.cache, 'miss');
  assert.equal(second.cache, 'hit');
  assert.equal(first.value, second.value);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(builds, 1);
});

test('prompt contribution telemetry keeps static and dynamic accounting separate', () => {
  assert.deepEqual(promptContributionTelemetry({ staticPrompt: '12345678', dynamicPrompt: '1234' }), {
    static_chars: 8,
    dynamic_chars: 4,
    static_estimated_tokens: 2,
    dynamic_estimated_tokens: 1,
  });
});

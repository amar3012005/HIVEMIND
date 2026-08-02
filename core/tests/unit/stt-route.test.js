import test from 'node:test';
import assert from 'node:assert/strict';

import { sttRoute, transcribeAudio } from '../../src/llm/stt-route.js';

const ENV_KEYS = [
  'STT_PROVIDER', 'STT_MODEL', 'MEETING_STT_MODEL', 'GROQ_API_KEY',
  'GROQ_BASE_URL', 'OPENROUTER_API_KEY', 'OPENROUTER_STT_URL',
  'OPENROUTER_STT_FALLBACK_MODEL',
];

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

test('STT selects the available provider when the configured provider has no credential', () => {
  const snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    process.env.STT_PROVIDER = 'groq';
    delete process.env.GROQ_API_KEY;
    process.env.OPENROUTER_API_KEY = 'or-test';
    const route = sttRoute('whisper-large-v3');
    assert.equal(route.provider, 'openrouter');
    assert.equal(route.model, 'nvidia/parakeet-tdt-0.6b-v3');
  } finally { restoreEnv(snapshot); }
});

test('STT falls back from Groq to OpenRouter without losing the transcript', async () => {
  const snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    process.env.STT_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = 'groq-test';
    process.env.GROQ_BASE_URL = 'https://groq.test/openai/v1';
    process.env.OPENROUTER_API_KEY = 'or-test';
    process.env.OPENROUTER_STT_URL = 'https://openrouter.test/audio/transcriptions';
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes('groq.test')) return new Response('provider unavailable', { status: 503 });
      return new Response(JSON.stringify({ text: 'durable transcript', language: 'en' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const result = await transcribeAudio({
      audio: Buffer.from('valid-audio-fixture'), contentType: 'audio/webm',
      filename: 'meeting.webm', model: 'whisper-large-v3', maxAttempts: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.text, 'durable transcript');
    assert.deepEqual(calls, [
      'https://groq.test/openai/v1/audio/transcriptions',
      'https://openrouter.test/audio/transcriptions',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(snapshot);
  }
});

test('STT preserves automatic language changes without forcing one language', async () => {
  const snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const expected = 'Guten Morgen. Let us review the roadmap. Danach entscheiden wir.';
  try {
    process.env.STT_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = 'groq-test';
    process.env.GROQ_BASE_URL = 'https://groq.test/openai/v1';
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.body.get('language'), null);
      assert.equal(options.body.get('model'), 'whisper-large-v3');
      return new Response(JSON.stringify({ text: expected, language: 'de' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const result = await transcribeAudio({
      audio: Buffer.from('mixed-language-audio-fixture'),
      contentType: 'audio/webm',
      filename: 'mixed-language-meeting.webm',
      model: 'whisper-large-v3',
      maxAttempts: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.text, expected);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(snapshot);
  }
});

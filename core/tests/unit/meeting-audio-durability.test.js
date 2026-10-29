import test from 'node:test';
import assert from 'node:assert/strict';
import { audioExtension, meetingAudioStorageKey } from '../../src/knowledge/meeting-audio-store.js';
import { audioRetryDelayMs } from '../../src/knowledge/meeting-audio-worker.js';

test('meeting audio storage key is tenant/session scoped and cannot traverse', () => {
  const key = meetingAudioStorageKey({
    orgId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222',
    idx: 3, checksum: 'a'.repeat(64), contentType: 'audio/webm;codecs=opus',
  });
  assert.equal(key, '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/3-' + 'a'.repeat(64) + '.webm');
  assert.throws(() => meetingAudioStorageKey({ orgId: '../bad', sessionId: '22222222-2222-4222-8222-222222222222', idx: 0, checksum: 'a'.repeat(64) }));
});

test('meeting audio formats and retry delay stay bounded', () => {
  assert.equal(audioExtension('audio/mp4'), 'm4a');
  assert.equal(audioExtension('audio/ogg'), 'ogg');
  assert.equal(audioRetryDelayMs(1), 30_000);
  assert.equal(audioRetryDelayMs(99), 30 * 60 * 1000);
});

import { processMeetingAudioSegment, MEETING_AUDIO_MAX_ATTEMPTS } from '../../src/knowledge/meeting-audio-worker.js';
import { isTranscriptTooThin } from '../../src/knowledge/meeting-finalization-worker.js';

const IDS = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
};

test('the audio retry budget survives a provider outage of about fifteen minutes', () => {
  assert.equal(MEETING_AUDIO_MAX_ATTEMPTS, 6);
  let waited = 0;
  for (let attempt = 1; attempt < MEETING_AUDIO_MAX_ATTEMPTS; attempt += 1) waited += audioRetryDelayMs(attempt);
  assert.ok(waited >= 14 * 60 * 1000, `waited ${waited}`);
});

test('a chunk with no speech is stored as a silent segment and does not fail the meeting', async () => {
  const originalFetch = globalThis.fetch;
  const executes = [];
  const prevEnv = { ...process.env };
  try {
    process.env.MEETING_AUDIO_STORE_DIR = (await import('node:os')).tmpdir() + '/meeting-audio-test-' + process.pid;
    const { persistMeetingAudio } = await import('../../src/knowledge/meeting-audio-store.js');
    const stored = await persistMeetingAudio({ orgId: IDS.orgId, sessionId: IDS.sessionId, idx: 0, contentType: 'audio/webm', bytes: Buffer.from('fake-audio') });
    process.env.STT_PROVIDER = 'groq'; process.env.GROQ_API_KEY = 'k'; process.env.GROQ_BASE_URL = 'https://groq.test/openai/v1';
    process.env.STT_CLOUDFLARE_FIRST = 'false'; delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = async () => new Response(JSON.stringify({ text: '   ', language: 'en' }), { status: 200, headers: { 'content-type': 'application/json' } });
    const prisma = {
      $queryRawUnsafe: async () => [{ storage_key: stored.storageKey, content_type: 'audio/webm', attempts: 1, start_ms: 0, end_ms: 60000 }],
      $executeRawUnsafe: async (sql, ...args) => { executes.push({ sql, args }); return 1; },
    };
    const result = await processMeetingAudioSegment(prisma, { ...IDS, idx: 0 });
    assert.equal(result.ok, true);
    assert.equal(result.silent, true);
    assert.match(executes[0].sql, /INSERT INTO hivemind\.meeting_segments/);
    assert.match(executes[0].sql, /extraction_status/);
    assert.match(executes[1].sql, /status='transcribed'/);
    assert.ok(!executes.some((e) => /status='error'/.test(e.sql)));
  } finally { globalThis.fetch = originalFetch; process.env = prevEnv; }
});

test('a recording with almost no words for its length is reported, a normal one is not', () => {
  assert.equal(isTranscriptTooThin({ words: 1, durationSec: 58 }), true);
  assert.equal(isTranscriptTooThin({ words: 4, durationSec: 600 }), true);
  assert.equal(isTranscriptTooThin({ words: 400, durationSec: 600 }), false);
  assert.equal(isTranscriptTooThin({ words: 1, durationSec: 20 }), false);
  assert.equal(isTranscriptTooThin({ words: 6, durationSec: 60 }), false);
});

test('a recording where every chunk was silent fails once with a plain message instead of retrying', async () => {
  const updates = [];
  const prisma = {
    $queryRawUnsafe: async (sql) => {
      if (/FROM hivemind\.meeting_sessions s\s+LEFT JOIN/.test(sql)) return [{
        status: 'queued', expected_segments: 1, finalized_meeting_id: null, finalization_payload: {}, finalization_attempts: 0,
        segment_count: 1, indexes: [0], audio_count: 1, audio_transcribed: 1, audio_terminal_errors: 0,
      }];
      if (/UPDATE hivemind\.meeting_sessions/.test(sql)) return [{ finalization_payload: { duration_sec: 12 }, finalization_attempts: 1 }];
      return [{ idx: 0, text: '', speakers: null, start_ms: 0, end_ms: 12000 }];
    },
    $executeRawUnsafe: async (...args) => { updates.push(args); return 1; },
  };
  const { processMeetingFinalization } = await import('../../src/knowledge/meeting-finalization-worker.js');
  const result = await processMeetingFinalization(prisma, IDS);
  assert.equal(result.terminal, true);
  assert.equal(updates[0][1], 'failed');
  assert.equal(updates[0][3], 'no_speech_detected');
  assert.match(updates[0][4], /No speech was detected/);
});

test('a transcribed chunk triggers finalization immediately instead of waiting for the next sweep', async () => {
  const { onMeetingAudioTranscribed } = await import('../../src/knowledge/meeting-audio-worker.js');
  const prevEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const seen = [];
  try {
    process.env.MEETING_AUDIO_STORE_DIR = (await import('node:os')).tmpdir() + '/meeting-audio-hook-' + process.pid;
    const { persistMeetingAudio } = await import('../../src/knowledge/meeting-audio-store.js');
    const stored = await persistMeetingAudio({ orgId: IDS.orgId, sessionId: IDS.sessionId, idx: 0, contentType: 'audio/webm', bytes: Buffer.from('fake-audio') });
    process.env.STT_PROVIDER = 'groq'; process.env.GROQ_API_KEY = 'k'; process.env.GROQ_BASE_URL = 'https://groq.test/openai/v1';
    process.env.STT_CLOUDFLARE_FIRST = 'false'; delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = async () => new Response(JSON.stringify({ text: 'Maria owns pricing.', language: 'en' }), { status: 200, headers: { 'content-type': 'application/json' } });
    onMeetingAudioTranscribed((identity) => { seen.push(identity); });
    const prisma = {
      $queryRawUnsafe: async () => [{ storage_key: stored.storageKey, content_type: 'audio/webm', attempts: 1, start_ms: 0, end_ms: 5000 }],
      $executeRawUnsafe: async () => 1,
    };
    const result = await processMeetingAudioSegment(prisma, { ...IDS, idx: 0 });
    assert.equal(result.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(seen, [{ sessionId: IDS.sessionId, orgId: IDS.orgId, userId: IDS.userId }]);
  } finally { globalThis.fetch = originalFetch; onMeetingAudioTranscribed(null); process.env = prevEnv; }
});

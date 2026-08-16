import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { __test as insightTest } from '../../src/knowledge/meeting-insights.js';
import {
  __test as finalizationTest,
  finalizationRetryDelayMs,
  processMeetingFinalization,
} from '../../src/knowledge/meeting-finalization-worker.js';

test('long meeting windowing preserves every transcript character in order', () => {
  const segments = Array.from({ length: 30 }, (_, index) =>
    `SEGMENT-${String(index).padStart(2, '0')} ` + `${'multilingual Besprechung निर्णय '.repeat(260)}\n`,
  );
  const transcript = segments.join('');
  const windows = insightTest.transcriptWindows(transcript);

  assert.ok(windows.length > 1);
  assert.equal(windows.join(''), transcript);
  assert.ok(windows.every((window) => window.length <= 48_000));
  assert.match(windows.at(-1), /SEGMENT-29/);
});

test('meeting insight merge deduplicates repeated facts and preserves multilingual details', () => {
  const merged = insightTest.mergeMeetingParts([
    {
      title: 'Solvis Gespräch', summary: 'Erster Teil.',
      key_points: ['Wärmepumpe startet im Juni', 'Entscheidung für Pilot'],
      decisions: ['Pilot beginnt am 12. Juni'], topics: ['Solvis'],
      entities: { people: ['Amar Sai'], organizations: ['SOLVIS'], dates: ['12. Juni'] },
      speaker_names: { SPEAKER_00: 'Amar Sai' },
    },
    {
      summary: 'दूसरा भाग।',
      key_points: ['Wärmepumpe startet im Juni', 'बजट की पुष्टि बाकी है'],
      decisions: ['Pilot beginnt am 12. Juni'], topics: ['Budget'],
      entities: { people: ['Nadia'], organizations: ['SOLVIS'], dates: [] },
      speaker_names: { SPEAKER_01: 'Nadia' },
    },
  ]);

  assert.deepEqual(merged.key_points, [
    'Wärmepumpe startet im Juni',
    'Entscheidung für Pilot',
    'बजट की पुष्टि बाकी है',
  ]);
  assert.deepEqual(merged.decisions, ['Pilot beginnt am 12. Juni']);
  assert.deepEqual(merged.entities.organizations, ['SOLVIS']);
  assert.deepEqual(merged.speaker_names, { SPEAKER_00: 'Amar Sai', SPEAKER_01: 'Nadia' });
});

test('finalization retries use bounded exponential backoff', () => {
  assert.equal(finalizationRetryDelayMs(1), 30_000);
  assert.equal(finalizationRetryDelayMs(2), 60_000);
  assert.equal(finalizationRetryDelayMs(99), 3_600_000);
});

test('readiness reports transcript gaps and does not confuse terminal audio with pending audio', async () => {
  const prisma = {
    $queryRawUnsafe: async () => [{
      status: 'queued', expected_segments: 3, finalized_meeting_id: null,
      finalization_payload: {}, finalization_attempts: 0,
      segment_count: 2, indexes: [0, 2], audio_count: 1,
      audio_transcribed: 0, audio_terminal_errors: 1,
    }],
  };
  const state = await finalizationTest.readiness(prisma, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
  });
  assert.deepEqual(state.missingIndexes, [1]);
  assert.equal(state.waitingAudio, true);
  assert.equal(state.terminalAudioErrors, 1);
});

test('terminal transcription failure settles the session instead of hanging in the queue', async () => {
  const updates = [];
  const prisma = {
    $queryRawUnsafe: async () => [{
      status: 'queued', expected_segments: 1, finalized_meeting_id: null,
      finalization_payload: {}, finalization_attempts: 0,
      segment_count: 0, indexes: [], audio_count: 1,
      audio_transcribed: 0, audio_terminal_errors: 1,
    }],
    $executeRawUnsafe: async (...args) => { updates.push(args); return 1; },
  };
  const result = await processMeetingFinalization(prisma, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(result.terminal, true);
  assert.equal(result.ok, false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][1], 'failed');
  assert.equal(updates[0][3], 'transcription_failed');
});

test('tenant-agent settlement casts the shared status parameter consistently', () => {
  const byod = fs.readFileSync(new URL('../../../byod/agent/server.mjs', import.meta.url), 'utf8');
  const embedded = fs.readFileSync(new URL('../../src/vector/mneme/embedded-agent.mjs', import.meta.url), 'utf8');
  for (const source of [byod, embedded]) {
    assert.match(source, /status=\$1::varchar\(24\)/);
    assert.match(source, /CASE WHEN \$1::text='ready'/);
  }
});

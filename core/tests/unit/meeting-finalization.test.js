import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { __test as insightTest } from '../../src/knowledge/meeting-insights.js';
import {
  __test as finalizationTest,
  finalizationRetryDelayMs,
  queueAbandonedMeetingSessions,
  processMeetingFinalization,
  reconcileMeetingFinalizations,
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

test('inactive recording recovery queues the acknowledged transcript without inventing missing segments', async () => {
  const calls = [];
  const prisma = {
    $queryRawUnsafe: async (...args) => {
      calls.push(args);
      return [{ id: 'session', org_id: 'org', user_id: 'user' }];
    },
  };
  const rows = await queueAbandonedMeetingSessions(prisma, { limit: 7, now: new Date('2026-08-17T00:00:00Z') });
  assert.equal(rows.length, 1);
  assert.match(calls[0][0], /s\.status='recording'/);
  assert.match(calls[0][0], /s\.consent_recorded=true/);
  assert.match(calls[0][0], /EXISTS \(\s*SELECT 1 FROM hivemind\.meeting_segments/);
  assert.match(calls[0][0], /expected_segments=NULL/);
  assert.match(calls[0][0], /'recovered_partial',true/);
  assert.match(calls[0][0], /FOR UPDATE SKIP LOCKED/);
  assert.equal(calls[0][3], 7);
});

test('the normal finalization reconciler promotes abandoned recordings before scanning queued work', async () => {
  let call = 0;
  const prisma = {
    $queryRawUnsafe: async () => {
      call += 1;
      return call === 1 ? [{ id: 'recovered', org_id: 'org', user_id: 'user' }] : [];
    },
  };
  const result = await reconcileMeetingFinalizations(prisma, { limit: 3 });
  assert.deepEqual(result, { recovered: 1, scanned: 0, completed: 0, failed: 0 });
  assert.equal(call, 2);
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
    assert.match(source, /MEETING_ABANDONED_AFTER_MS/);
    assert.match(source, /'recovered_partial',true/);
    assert.match(source, /status='recording'/);
    assert.match(source, /consent_recorded=true/);
    assert.match(source, /INSERT INTO meeting_sessions\s*\(id,?\s*org_id,?\s*user_id,?\s*status,?\s*consent_recorded\)/);
  }
});

test('central and tenant paths preserve partial-recovery provenance and transcript heartbeats', () => {
  const central = fs.readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
  const remoteWorker = fs.readFileSync(new URL('../../src/knowledge/meeting-remote-finalization-worker.js', import.meta.url), 'utf8');
  assert.match(central, /durable recorder heartbeat/);
  assert.match(central, /status='recording'/);
  assert.match(remoteWorker, /payload\.recovered_partial === true/);
  assert.match(remoteWorker, /transcript_segments: segments\.length/);
});

test('an explicit finalize retry reopens a terminal failure in central and tenant storage', async () => {
  const centralQueries = [];
  const centralUpdates = [];
  const prisma = {
    $queryRawUnsafe: async (query) => {
      centralQueries.push(query);
      return [{ id: 'session', status: 'queued', finalized_meeting_id: null, expected_segments: 1 }];
    },
    $executeRawUnsafe: async (query) => { centralUpdates.push(query); return 1; },
  };
  const { queueMeetingFinalization } = await import('../../src/knowledge/meeting-finalization-worker.js');
  await queueMeetingFinalization(prisma, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333', expectedSegments: 1, payload: {},
  });
  assert.match(centralQueries[0], /finalization_attempts=CASE WHEN status='failed' THEN 0 ELSE finalization_attempts END/);
  assert.match(centralUpdates[0], /extraction_status='pending'/);
  assert.match(centralUpdates[0], /extraction_attempts=0/);

  const byod = fs.readFileSync(new URL('../../../byod/agent/server.mjs', import.meta.url), 'utf8');
  const embedded = fs.readFileSync(new URL('../../src/vector/mneme/embedded-agent.mjs', import.meta.url), 'utf8');
  for (const source of [byod, embedded]) {
    assert.match(source, /finalization_attempts=CASE WHEN status='failed' THEN 0 ELSE finalization_attempts END/);
  }
});

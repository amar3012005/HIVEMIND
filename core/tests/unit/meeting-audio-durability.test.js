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

import test from 'node:test';
import assert from 'node:assert/strict';
import { compactRoomContext, normalizeRoomText, wakeIntent } from './room-contract.js';
import { addRealtimeParticipant, createRealtimeMeeting, refreshRealtimeParticipant } from './realtimekit-client.js';

test('wake phrase is deterministic and strips the address', () => {
  assert.deepEqual(wakeIntent('HIVEMIND, what do you think?'), { addressed: true, query: 'what do you think?' });
  assert.equal(wakeIntent('I think the plan is ready').addressed, false);
});

test('room context stays bounded and removes control bytes', () => {
  const transcript = Array.from({ length: 20 }, (_, i) => ({ speaker_name: `P${i}`, text: `line\u0000 ${i}` }));
  const result = compactRoomContext({ room: { id: 'r', name: 'Ops', goal: 'Plan' }, transcript, roster: [], speaker: { name: 'Amar' } });
  assert.equal(result.recent_transcript.length, 10);
  assert.equal(result.recent_transcript[0].text, 'line 10');
  assert.equal(normalizeRoomText('a\u0000b'), 'ab');
});

test('RealtimeKit calls use server credentials and stable user identity', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ success: true, result: { id: 'meeting-1', token: 'participant-token' } }) };
  };
  const env = { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_REALTIMEKIT_APP_ID: 'app', CLOUDFLARE_REALTIMEKIT_API_TOKEN: 'token', CLOUDFLARE_REALTIMEKIT_HOST_PRESET: 'host', CLOUDFLARE_REALTIMEKIT_MEMBER_PRESET: 'member' };
  await createRealtimeMeeting({ title: 'Company Room', env, fetchImpl });
  await addRealtimeParticipant({ meetingId: 'meeting-1', userId: 'user-uuid', name: 'Verified User', isHost: false, env, fetchImpl });
  await refreshRealtimeParticipant({ meetingId: 'meeting-1', participantId: 'participant-1', env, fetchImpl });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/account/realtime/kit/app/meetings');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token');
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: 'Verified User', preset_name: 'member', custom_participant_id: 'user-uuid' });
  assert.match(calls[2].url, /participants\/participant-1\/token$/);
});

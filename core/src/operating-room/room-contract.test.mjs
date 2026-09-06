import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoomChatRequest, compactRoomContext, normalizeRoomText, wakeIntent } from './room-contract.js';
import { addRealtimeParticipant, createRealtimeMeeting, refreshRealtimeParticipant } from './realtimekit-client.js';
import { closeOperatingRoomBridge, speakOperatingRoomBridge, startOperatingRoomBridge } from './room-bridge-client.js';
import { transcriptEventId, normalizeSessionBrief, advanceRoomBrief, patchRoomState, claimRoomResponse, releaseRoomResponse, synthesizeRoomResponse } from './conversation-state.js';

test('room synthesis keeps live discussion evidence even when company recall has no matches',async()=>{
 const context={current_speaker:{name:'Bea',user_id:'b'},recent_transcript:[{speaker:'Alex',text:'The confirmed budget is 700 euros.'}]};
 let input;
 const answer=await synthesizeRoomResponse({context,query:'What budget did Alex confirm?',knowledge:{response:'No matching sources',sources:[]},fetchCompletion:async(model,options)=>{input=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:'Bea, Alex confirmed 700 euros.'}}]})};}});
 const payload=JSON.parse(input.messages[1].content);
 assert.deepEqual(payload.room_context,context);
 assert.equal(payload.current_request,'What budget did Alex confirm?');
 assert.equal(payload.company_knowledge,null);
 assert.match(input.messages[0].content,/recall miss does not invalidate/);
 assert.match(answer,/700/);
});

test('five speakers retain distinct stable transcript IDs across retries and rooms', () => {
  const ids = Array.from({length:5},(_,i)=>transcriptEventId('room',`user-${i}`,'event'));
  assert.equal(new Set(ids).size,5);
  assert.equal(ids[0],transcriptEventId('room','user-0','event'));
  assert.notEqual(ids[0],transcriptEventId('other-room','user-0','event'));
});

test('rolling brief rejects invented references and retains earlier unresolved items', () => {
  const previous={open_items:[{text:'Confirm budget',turn_ids:['older']}],decisions:[]};
  const brief=normalizeSessionBrief({summary:'Discussion continues',decisions:[{text:'Invented approval',turn_ids:['missing']}],open_items:[{text:'Choose date',turn_ids:['a']}]},[{id:'a',createdAt:'2026-09-06T10:00:00Z'}],previous);
  assert.equal(brief.decisions.length,0);
  assert.deepEqual(brief.open_items.map(x=>x.text),['Confirm budget','Choose date']);
  assert.equal(brief.through.id,'a');
});

test('room state patches and response leases are tenant scoped and do not replace the playbook',async()=>{
  const calls=[];
  const query=async (parts,...values)=>{calls.push({sql:parts.join('?'),values});return [{id:'room',room_playbook:{agenda:['Review']}}];};
  const prisma={$queryRaw:query,$executeRaw:query};
  const room={id:'room',orgId:'org'};
  await patchRoomState(prisma,room,{agenda:['Review']});
  const token=await claimRoomResponse(prisma,room,'turn');
  await releaseRoomResponse(prisma,room,token);
  for(const call of calls){assert.match(call.sql,/org_id=/);assert.ok(call.values.includes('org'));}
  assert.match(calls[0].sql,/\|\|/);
  assert.match(calls[1].sql,/expires_at/);
  assert.ok(calls[2].values.includes(token));
});

test('one hour of five-person speech is compacted in bounded batches without skipping the cursor',async()=>{
  const all=Array.from({length:100},(_,i)=>({id:String(i).padStart(4,'0'),speakerUserId:`user-${i%5}`,speakerName:`Person ${i%5}`,speakerRole:'member',text:`Point ${i}`,createdAt:new Date(Date.UTC(2026,8,6,10,0,i*36))}));
  const queries=[];let state={};let maxBatch=0;
  const prisma={operatingRoomEvent:{findMany:async q=>{queries.push(q);const cursor=q.where.OR?.[1].id.gt;return all.filter(row=>!cursor||row.id>cursor).slice(0,q.take);}},$queryRaw:async(parts,...values)=>{state={...state,...JSON.parse(values[0])};return [{room_playbook:state}];}};
  const fetchCompletion=async(model,options)=>{const input=JSON.parse(JSON.parse(options.body).messages[1].content);maxBatch=Math.max(maxBatch,input.turns.length);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({summary:`Through ${input.turns.at(-1).id}`,decisions:[],open_items:[]})}}]})};};
  const room={id:'room',orgId:'org',roomPlaybook:state};
  await advanceRoomBrief(prisma,room,{fetchCompletion});
  room.roomPlaybook=state;
  await advanceRoomBrief(prisma,room,{fetchCompletion});
  assert.equal(state.session_brief.through.id,'0099');
  assert.equal(maxBatch,32);
  assert.equal(queries[2].where.OR[1].id.gt,'0063');
});

test('wake phrase is deterministic and strips the address', () => {
  assert.deepEqual(wakeIntent('HIVEMIND, what do you think?'), { addressed: true, query: 'what do you think?' });
  assert.equal(wakeIntent('I think the plan is ready').addressed, false);
});

test('room context stays bounded and removes control bytes', () => {
  const transcript = Array.from({ length: 30 }, (_, i) => ({ id: `turn-${i}`, speaker_user_id: `user-${i}`, speaker_name: `P${i}`, text: `line\u0000 ${i}` }));
  const result = compactRoomContext({ room: { id: 'r', name: 'Ops', goal: 'Plan' }, transcript, roster: [], speaker: { name: 'Amar' } });
  assert.equal(result.recent_transcript.length, 24);
  assert.equal(result.recent_transcript[0].text, 'line 6');
  assert.equal(result.recent_transcript[0].speaker_user_id, 'user-6');
  assert.equal(normalizeRoomText('a\u0000b'), 'ab');
});

test('room chat request carries verified speaker identity, shared history, goal, and stable turn idempotency', () => {
  const room = { id: '11111111-1111-1111-1111-111111111111', name: 'Strategy', goal: 'Choose the launch plan', roomPlaybook: { goal_state: 'Pricing reviewed', decisions: ['Launch in Germany'], open_items: ['Choose date'] } };
  const turn = { id: '22222222-2222-2222-2222-222222222222', speaker_user_id: '33333333-3333-3333-3333-333333333333', speaker_name: 'Amar', speaker_role: 'owner', text: 'HIVEMIND, what remains?', query: 'what remains?' };
  const context = compactRoomContext({ room, speaker: { user_id: turn.speaker_user_id, name: 'Amar', role: 'owner' }, roster: [{ user_id: turn.speaker_user_id, name: 'Amar', role: 'owner' }], transcript: [{ id: turn.id, speaker_user_id: turn.speaker_user_id, speaker_name: 'Amar', speaker_role: 'owner', text: turn.text }] });
  const request = buildRoomChatRequest({ room, turn, context });
  assert.match(request.message, /Current speaker: Amar \(owner, user 33333333/);
  assert.match(request.message, /Still open: Choose date/);
  assert.equal(request.conversation_id, room.id);
  assert.equal(request.idempotency_key, `operating-room-turn:${turn.id}`);
  assert.equal(request.use_tools, false);
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
  await addRealtimeParticipant({ meetingId: 'meeting-1', userId: 'room-uuid', name: 'HIVEMIND · TARA', isHost: true, env, fetchImpl });
  await refreshRealtimeParticipant({ meetingId: 'meeting-1', participantId: 'participant-1', env, fetchImpl });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/account/realtime/kit/app/meetings');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token');
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: 'Verified User', preset_name: 'member', custom_participant_id: 'user-uuid' });
  assert.deepEqual(JSON.parse(calls[2].options.body), { name: 'HIVEMIND · TARA', preset_name: 'host', custom_participant_id: 'room-uuid' });
  assert.match(calls[3].url, /participants\/participant-1\/token$/);
});

test('Operating Room bridge calls are authenticated, bounded, and idempotent by room id', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ status: 'ready' }) };
  };
  const env = { PLAYWRIGHT_SERVICE_TOKEN: 'internal-token', OPERATING_ROOM_BRIDGE_URL: 'http://bridge/v1/room-bridges/' };
  await startOperatingRoomBridge({ roomId: '11111111-1111-1111-1111-111111111111', meetingId: 'meeting-1', participantId: 'bot-1', authToken: 'bot-token', env, fetchImpl });
  await speakOperatingRoomBridge({ roomId: '11111111-1111-1111-1111-111111111111', turnId: 'turn-1', answer: 'Hello Amar', env, fetchImpl });
  await closeOperatingRoomBridge({ roomId: '11111111-1111-1111-1111-111111111111', env, fetchImpl });
  assert.equal(calls[0].url, 'http://bridge/v1/room-bridges/11111111-1111-1111-1111-111111111111');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer internal-token');
  assert.equal(JSON.parse(calls[0].options.body).auth_token, 'bot-token');
  assert.match(calls[1].url, /\/speak$/);
  assert.deepEqual(JSON.parse(calls[1].options.body), { turn_id: 'turn-1', answer: 'Hello Amar' });
  assert.equal(calls[2].options.method, 'DELETE');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleNativeRuntimeVoice } from '../src/tara/native-runtime-voice.js';
import { createTaraGrokRuntime } from '../src/tara/grok-runtime.js';
const secret = 'native-voice-contract-test-secret-32-characters';
const user = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';
const call = '33333333-3333-4333-8333-333333333333';
const room = 'session-46d220df35a3f985de773d7832c82d8e';
function token() {
 const now = Math.floor(Date.now()/1000);
 const parts = [{ alg:'HS256',typ:'JWT' },{ iss:'hivemind-harness-runner',aud:'hivemind-control-plane-harness-proxy',sub:user,org_id:org,profile:'hivemind-chat',iat:now,exp:now+30,jti:crypto.randomUUID() }].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url'));
 const input=parts.join('.'); return `${input}.${crypto.createHmac('sha256',secret).update(input).digest('base64url')}`;
}
async function run({ authorization=token(), active=true, body={}, callStatus='completed', expectedRoom=room, method='POST', suffix='' }={}) {
 let output; let invoked;
 await handleNativeRuntimeVoice({ pathname:`/internal/v1/harness-chat/core/v1/tara/native-voice${suffix}`,req:{ method,headers:{authorization:`Bearer ${authorization}`},url:`/?session_id=${expectedRoom}` },res:{},secret,parseBody:async()=>body,jsonResponse:(_,value,status=200)=>{output={value,status}},handler:async value=>{invoked=value},prisma:{userOrganization:{findUnique:async()=>({isActive:active})},taraVoiceSession:{findFirst:async()=>({configSnapshot:{native_session_id:room}})},taraProviderEvent:{findFirst:async()=>({payload:{interrupted:false}})},taraCall:{findFirst:async()=>({id:call,status:callStatus})},taraTurn:{findMany:async()=>[{seq:1,userText:'Our next priority is customer research.',agentText:'I will record that direction.'}]}} });
 return {output,invoked};
}
test('native creation accepts only signed runner authority and pins user/org',async()=>{
 const body={session_id:room,instructions:'You are Runtime.',opening_instruction:'Welcome Aster.',initial_check_in:true};
 const valid=await run({body}); assert.equal(valid.invoked.nativeRuntimeContext.session_id,room);assert.equal(valid.invoked.userId,user);assert.equal(valid.invoked.orgId,org);
 assert.equal((await run({body,authorization:'browser-token'})).output.status,401);
 assert.equal((await run({body,active:false})).output.status,403);
 assert.equal((await run({body:{...body,session_id:'unknown'}})).output.status,400);
});
test('terminal transcript lookup is bound to exact native room, not just tenant',async()=>{
 const value=await run({method:'GET',suffix:`/${call}`});assert.equal(value.output.value.session_id,room);assert.equal(value.output.value.turns.length,1);
 assert.equal((await run({method:'GET',suffix:`/${call}`,expectedRoom:'session-other'})).output.status,404);
 assert.equal((await run({method:'GET',suffix:`/${call}`,callStatus:'active'})).output.status,202);
});
test('native Runtime explicitly selects Grok and preserves negotiated PCM and voice settings',async()=>{
 const previous=process.env.TARA_GROK_CAPABILITY_SECRET;
 process.env.TARA_GROK_CAPABILITY_SECRET=secret;
 try {
  let saved; let output;
  const config={defaultProvider:'deepgram',revision:7,grokConfig:{voice_id:'eve',language:'de'}};
  const handler=createTaraGrokRuntime({prisma:{
   taraRuntimeConfig:{upsert:async()=>config,update:async()=>config},
   taraVoiceSession:{create:async({data})=>{saved=data;return {id:call}}},
  }});
  await handler({pathname:'/api/tara/voice-sessions',method:'POST',body:{mode:'internal'},
   req:{headers:{}},res:{},userId:user,orgId:org,
   nativeRuntimeContext:{session_id:room,instructions:'You are Runtime.',opening_instruction:'Welcome.',initial_check_in:true},
   jsonResponse:(_,value,status=200)=>{output={value,status}},
  });
  assert.equal(output.status,200);
  assert.equal(output.value.provider,'grok');
  assert.deepEqual(output.value.audio_format,{type:'pcm16',sample_rate:16000});
  assert.equal(saved.configSnapshot.voice_id,'eve');
  assert.equal(saved.configSnapshot.language,'de');
  assert.equal(saved.configSnapshot.interaction_profile,'native_runtime');
  assert.equal(saved.configSnapshot.instructions,'You are Runtime.');
 } finally {
  if(previous===undefined) delete process.env.TARA_GROK_CAPABILITY_SECRET;
  else process.env.TARA_GROK_CAPABILITY_SECRET=previous;
 }
});

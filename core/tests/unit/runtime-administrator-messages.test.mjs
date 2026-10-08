import test from 'node:test';
import assert from 'node:assert/strict';
import { messageAdministrator, validateAdministratorMessage, savedAdministratorRequest } from '../../src/harness-chat/runtime-administrator-messages.js';
import { renderRuntimeAdministratorEmail } from '../../src/email/templates/runtime-administrator.js';
const claims={sub:'11111111-1111-4111-8111-111111111111',org_id:'22222222-2222-4222-8222-222222222222',operating_role:'runtime',operating_session:'session-test'};
const input={message_key:'task-result-1',kind:'completion',subject:'Your review is ready',message:'I checked Sofia’s review. It is ready to view.'};
function database({role='admin',active=true,enabled=true}={}) {
 let row; const db={
  userOrganization:{findUnique:async()=>({role,isActive:active})},user:{findUnique:async()=>({email:'admin@example.com',displayName:'Amar'})},organization:{findUnique:async()=>({name:'SINGULANCE'})},hqRuntime:{findUnique:async()=>({ownerUserId:claims.sub,emailUpdatesEnabled:enabled})},
  $transaction:async fn=>fn(db),
  $queryRawUnsafe:async (sql,...args)=>{
   if(sql.includes('set_config'))return [];
   if(sql.includes('information_schema'))return[{table_schema:'harness'}];
   if(sql.includes('harness_sessions'))return[{id:claims.operating_session}];
   if(sql.includes('harness_session_events'))return [];
   if(sql.startsWith('INSERT')) {row??={id:'33333333-3333-4333-8333-333333333333',content_hash:args[4],status:'pending',message:JSON.parse(args[5])};return[{id:row.id}];}
   if(sql.startsWith('SELECT *'))return[{...row}];
   if(sql.includes("status='dispatching'")){row.status='dispatching';return[{id:row.id}];}
   if(sql.startsWith('UPDATE')){row.status=args[1];row.receipt=JSON.parse(args[2]);return[{id:row.id}];}
   throw Error(sql);
  }
 };return db;
}
test('Runtime overlay reuses branded shell and escapes all human text',()=>{
 const r=renderRuntimeAdministratorEmail({companyName:'SINGULANCE',administratorName:'<Amar>',subject:'Review <ready>',message:'<script>bad()</script>\nYour review is ready.',kind:'approval',conversationUrl:'https://next.singulancelabs.com/hivemind/app/employee/harness',portraitUrl:'https://chat.singulancelabs.com/assets/runtime-computer-c2305f5b.webp'});
 assert.ok(r.html.includes('HIVEMIND / SYSTEM MESSAGE'));assert.ok(r.html.includes('Your AI Chief of Staff'));assert.ok(!r.html.includes('<script>'));assert.ok(r.html.includes('&lt;Amar&gt;'));assert.ok(r.html.includes('Opening this email or its link does not grant approval'));assert.ok(r.text.includes('Review request:'));
});
test('recipient overrides and unbound decision references are rejected',()=>{
 assert.throws(()=>validateAdministratorMessage({...input,to:'someone@example.com'}));assert.throws(()=>validateAdministratorMessage({...input,kind:'decision'}));assert.throws(()=>validateAdministratorMessage({...input,subject:'Header\ninjection'}));
});
test('employee, inactive and non-admin callers cannot send',async()=>{
 for(const [db,c] of [[database(),{...claims,operating_role:undefined}],[database({active:false}),claims],[database({role:'member'}),claims]])await assert.rejects(messageAdministrator({db,claims:c,input,send:()=>{throw Error('must not send');}}));
});
test('accepted send is saved and repeated call does not send twice',async()=>{
 const db=database();let count=0;const send=async args=>{count++;assert.equal(args.to,'admin@example.com');assert.equal(args.requiredProvider,'cloudflare');assert.equal(args.providerAttempts,1);assert.equal(args.providerFallback,false);return{ok:true,provider:'cloudflare',messageId:'cf-1',deliveryStatus:'queued'};};
 const first=await messageAdministrator({db,claims,input,send});const replay=await messageAdministrator({db,claims,input,send});assert.equal(first.status,'accepted');assert.equal(replay.replayed,true);assert.equal(count,1);assert.equal(replay.receipt.messageId,'cf-1');
 await assert.rejects(messageAdministrator({db,claims,input:{...input,message:'changed'},send}),/content_conflict/);assert.equal(count,1);
});
test('unknown provider outcome stays unknown and is never blindly resent',async()=>{
 const db=database();let count=0;const send=async()=>{count++;throw Error('timeout');};
 assert.equal((await messageAdministrator({db,claims,input,send})).status,'unknown');assert.equal((await messageAdministrator({db,claims,input,send})).status,'unknown');assert.equal(count,1);
});
test('disabled preference and nonexistent native question do not send',async()=>{
 assert.equal((await messageAdministrator({db:database({enabled:false}),claims,input,send:()=>{throw Error('not allowed');}})).status,'disabled');
 await assert.rejects(messageAdministrator({db:database(),claims,input:{...input,kind:'decision',request_call_id:'call-1'},send:()=>{throw Error('not allowed');}}),/native_request_not_found/);
});

test('asynchronous delegated blocker references require exact root, state, kind and stable key',()=>{
 const data={id:'hq-blocker-1',state:'blocked',rootId:claims.operating_session,taskId:'task-16',employeeSessionId:'employee-room',kind:'connection'};
 const row={event_type:'hivemind/hq-delegated-blocker',payload:{data}};
 const msg={request_call_id:data.id,message_key:`${data.id}-user-request`,kind:'approval'};
 assert.equal(savedAdministratorRequest([row],msg,claims.operating_session),true);
 for(const bad of [{...msg,kind:'decision'},{...msg,message_key:'other'},{...msg,request_call_id:'invented'}])assert.equal(savedAdministratorRequest([row],bad,claims.operating_session),false);
 assert.equal(savedAdministratorRequest([{...row,payload:{data:{...data,rootId:'other'}}}],msg,claims.operating_session),false);
 assert.equal(savedAdministratorRequest([{...row,payload:{data:{...data,state:'resumed'}}},row],msg,claims.operating_session),false);
 const human={...row,payload:{data:{...data,kind:'human_input'}}};
 assert.equal(savedAdministratorRequest([human],{...msg,kind:'decision'},claims.operating_session),true);
 assert.equal(savedAdministratorRequest([human],msg,claims.operating_session),false);
});

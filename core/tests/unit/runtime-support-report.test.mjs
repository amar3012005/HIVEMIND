import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeSupportReport,nightlyRoutineContext,validateSupportReport} from '../../src/harness-chat/runtime-support-report.js';
const org='22222222-2222-4222-8222-222222222222',user='11111111-1111-4111-8111-111111111111';
const now=Date.parse('2026-10-09T05:00:00.000Z');
const payload=()=>({operation:'submit',occurrence:'2026-10-09T02:00:00.000Z',coverage:{expected:11,inspected:10,missing:1},issues:[{capability:'crm',code:'invalid_identifier',severity:'high',count:2,cause:'confirmed'}]});
function fixture(){
 let saved,sendCount=0;const calls=[];
 const db={userOrganization:{findUnique:async()=>({role:'admin',isActive:true})},user:{findUnique:async()=>({deletedAt:null})},organization:{findUnique:async()=>({companyProfile:{timezone:'Europe/Berlin'}})},
  $queryRawUnsafe:async(sql,...args)=>{calls.push({sql,args});if(sql.includes('set_config'))return [];if(sql.includes('organization_agent_storage_scope'))return [{storage_user_id:user,runtime_session_id:'session-chief'}];if(sql.includes('JOIN hivemind.harness_sessions'))return [{session_id:'session-chief'}];
   if(sql.startsWith('INSERT')){saved??={id:'33333333-3333-4333-8333-333333333333',status:'pending',content_hash:args[4],message:JSON.parse(args[5])};return [];}
   if(sql.startsWith('SELECT *'))return saved?[saved]:[];
   if(sql.includes("SET status='dispatching'")){saved.status='dispatching';return [];}
   if(sql.startsWith('UPDATE')){saved.status=args[1];saved.receipt=JSON.parse(args[2]);return [];}
   if(sql.includes('system_email_deliveries'))return [{delivery_status:'delivered'}];throw Error(sql);},
  $transaction:async fn=>fn(db)};
 const claims={sub:user,org_id:org,operating_role:'runtime',operating_session:'session-chief'};
 const send=async args=>{sendCount++;calls.push({mail:args});return {ok:true,provider:'cloudflare',messageId:'provider-message',deliveryStatus:'accepted'};};
 return {db,claims,send,env:{SYSTEM_EMAIL_SUPPORT:'support@example.invalid'},now,calls,get sends(){return sendCount;},get saved(){return saved;}};
}
test('strict sanitized vocabulary rejects company text, identity, oversized counts and future occurrence',()=>{
 for(const mutate of [p=>p.message='customersecret',p=>p.issues[0].details='raw logs',p=>p.issues[0].capability='customer name',p=>p.coverage.expected=2000,p=>p.occurrence='2026-10-10T02:00:00.000Z']){const p=payload();mutate(p);assert.throws(()=>validateSupportReport(p,now));}
 assert.deepEqual(validateSupportReport(payload(),now),payload());
});
test('canonical Runtime current admin only; member and employee denied',async()=>{
 const f=fixture();f.claims.operating_role='employee';await assert.rejects(runtimeSupportReport({...f,input:payload()}),/runtime_authority/);
 f.claims.operating_role='runtime';f.db.userOrganization.findUnique=async()=>({role:'member',isActive:true});await assert.rejects(runtimeSupportReport({...f,input:payload()}),/membership/);assert.equal(f.sends,0);
});
test('configured support recipient is server-only; exact occurrence sends once, altered content rejected',async()=>{
 const f=fixture();const first=await runtimeSupportReport({...f,input:payload()});assert.equal(first.sent,true);assert.equal(first.delivery_status,'delivered');assert.equal(first.read_status,'not_tracked');
 const second=await runtimeSupportReport({...f,input:payload()});assert.equal(second.replayed,true);assert.equal(f.sends,1);
 const mail=f.calls.find(c=>c.mail).mail;assert.equal(mail.to,'support@example.invalid');assert.equal(mail.requiredProvider,'cloudflare');assert.equal(mail.providerFallback,false);assert.ok(!mail.rendered.text.includes(org));assert.ok(!JSON.stringify(first).includes('support@'));
 const changed=payload();changed.issues[0].count=3;await assert.rejects(runtimeSupportReport({...f,input:changed}),/content_conflict/);
 const status=await runtimeSupportReport({...f,input:{operation:'status',occurrence:payload().occurrence}});assert.equal(status.delivery_status,'delivered');assert.equal(f.sends,1);
});
test('missing configuration safely keeps unsent pending report; no alternate transport',async()=>{
 const f=fixture();f.env={};const r=await runtimeSupportReport({...f,input:payload()});assert.equal(r.status,'unavailable');assert.equal(f.sends,0);assert.equal(f.saved.status,'pending');
});
test('uncertain provider outcome prevents automatic duplicate retry',async()=>{
 const f=fixture();let attempts=0;f.send=async()=>{attempts++;throw Error('token should never be copied');};const r=await runtimeSupportReport({...f,input:payload()});assert.equal(r.status,'unknown');assert.ok(!JSON.stringify(r).includes('token'));await runtimeSupportReport({...f,input:payload()});assert.equal(attempts,1);
});
test('nightly context attests canonical room, validates organization zone, and never returns support address',async()=>{
 const f=fixture();const r=await nightlyRoutineContext(f);assert.deepEqual(r,{org_id:org,session_id:'session-chief',time_zone:'Europe/Berlin',time_zone_source:'organization',support_configured:true});
 f.db.organization.findUnique=async()=>({companyProfile:{timezone:'invalid'}});assert.equal((await nightlyRoutineContext(f)).time_zone_source,'default_utc');
 const query=f.db.$queryRawUnsafe;f.db.$queryRawUnsafe=(sql,...args)=>sql.includes('JOIN hivemind.harness_sessions')?[]:query(sql,...args);await assert.rejects(nightlyRoutineContext(f),/canonical_runtime/);
});

test('shared admins dedupe on canonical storage identity; status never creates or sends a report',async()=>{
 const f=fixture();const empty=await runtimeSupportReport({...f,input:{operation:'status',occurrence:payload().occurrence},sharedOrganizationAgents:true});assert.equal(empty.status,'not_found');assert.equal(f.saved,undefined);assert.equal(f.sends,0);
 await runtimeSupportReport({...f,input:payload(),sharedOrganizationAgents:true});
 f.claims.sub='44444444-4444-4444-8444-444444444444';const second=await runtimeSupportReport({...f,input:payload(),sharedOrganizationAgents:true});assert.equal(second.replayed,true);assert.equal(f.sends,1);
 for(const insert of f.calls.filter(c=>c.sql?.startsWith('INSERT')))assert.equal(insert.args[1],user);
});

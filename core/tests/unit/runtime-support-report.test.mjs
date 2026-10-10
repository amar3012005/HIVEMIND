import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeSupportReport,nightlyRoutineContext,validateSupportReport,savedNightlyOccurrence} from '../../src/harness-chat/runtime-support-report.js';
const org='22222222-2222-4222-8222-222222222222',user='11111111-1111-4111-8111-111111111111';
const now=Date.parse('2026-10-09T05:00:00.000Z');
const payload=()=>({operation:'submit',occurrence:'2026-10-09T02:00:00.000Z',coverage:{expected:11,inspected:10,missing:1},issues:[{capability:'crm',code:'invalid_identifier',severity:'high',count:2,cause:'confirmed'}]});
function witness(session='session-chief',occurrence=payload().occurrence){return {event_type:'user/message',payload:{data:{source:{kind:'schedule',occurrenceAt:occurrence},content:[{type:'text',text:'reminders_json: '+JSON.stringify([{schedule_id:'schedule-'+crypto.createHash('sha256').update(session+'\0nightly-routine-check-v1').digest('hex'),occurrence_at:occurrence,reminder_prompt:'Load hivemind-nightly-routine-check. Execute authorized inspection.'}])}]}}};}
function fixture(){
 let saved,sendCount=0;const calls=[];
 const db={userOrganization:{findUnique:async()=>({role:'admin',isActive:true})},user:{findUnique:async()=>({deletedAt:null})},organization:{findUnique:async()=>({name:'Test organization',companyProfile:{timezone:'Europe/Berlin'}})},
  $queryRawUnsafe:async(sql,...args)=>{calls.push({sql,args});if(sql.includes('set_config'))return [];if(sql.includes('organization_agent_storage_scope'))return [{storage_user_id:user,runtime_session_id:'session-chief'}];if(sql.includes('JOIN hivemind.harness_sessions'))return [{session_id:'session-chief'}];
   if(sql.includes('FROM hivemind.harness_session_events'))return [witness()];
   if(sql.startsWith('INSERT')){saved??={id:'33333333-3333-4333-8333-333333333333',status:'pending',content_hash:args[4],message:JSON.parse(args[5])};return [];}
   if(sql.startsWith('SELECT *'))return saved?[saved]:[];
   if(sql.includes("SET status='dispatching'")){saved.status='dispatching';return [];}
   if(sql.startsWith('UPDATE')){saved.status=args[1];saved.receipt=JSON.parse(args[2]);return [];}
   if(sql.includes('system_email_deliveries'))return [{delivery_status:'delivered'}];throw Error(sql);},
  $transaction:async fn=>fn(db)};
 const claims={sub:user,org_id:org,operating_role:'runtime',operating_session:'session-chief'};
 const send=async args=>{sendCount++;calls.push({mail:args});return {ok:true,provider:'cloudflare',messageId:'provider-message',deliveryStatus:'accepted'};};
 return {db,claims,send,env:{SYSTEM_EMAIL_SUPPORT:'support@example.invalid',RUNTIME_NIGHTLY_SUPPORT_ORG_IDS:org},now,calls,get sends(){return sendCount;},get saved(){return saved;}};
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
 const f=fixture();f.env={RUNTIME_NIGHTLY_SUPPORT_ORG_IDS:org};const r=await runtimeSupportReport({...f,input:payload()});assert.equal(r.status,'unavailable');assert.equal(f.sends,0);assert.equal(f.saved.status,'pending');
});
test('uncertain provider outcome prevents automatic duplicate retry',async()=>{
 const f=fixture();let attempts=0;f.send=async()=>{attempts++;throw Error('token should never be copied');};const r=await runtimeSupportReport({...f,input:payload()});assert.equal(r.status,'unknown');assert.ok(!JSON.stringify(r).includes('token'));await runtimeSupportReport({...f,input:payload()});assert.equal(attempts,1);
});
test('nightly context attests canonical room, validates organization zone, and never returns support address',async()=>{
 const f=fixture();const r=await nightlyRoutineContext(f);assert.deepEqual(r,{org_id:org,session_id:'session-chief',time_zone:'Europe/Berlin',time_zone_source:'organization',support_configured:true});
 f.db.organization.findUnique=async()=>({name:'Test organization',companyProfile:{timezone:'invalid'}});assert.equal((await nightlyRoutineContext(f)).time_zone_source,'default_utc');
 const query=f.db.$queryRawUnsafe;f.db.$queryRawUnsafe=(sql,...args)=>sql.includes('JOIN hivemind.harness_sessions')?[]:query(sql,...args);await assert.rejects(nightlyRoutineContext(f),/canonical_runtime/);
});

test('shared admins dedupe on canonical storage identity; status never creates or sends a report',async()=>{
 const f=fixture();const empty=await runtimeSupportReport({...f,input:{operation:'status',occurrence:payload().occurrence},sharedOrganizationAgents:true});assert.equal(empty.status,'not_found');assert.equal(f.saved,undefined);assert.equal(f.sends,0);
 await runtimeSupportReport({...f,input:payload(),sharedOrganizationAgents:true});
 f.claims.sub='44444444-4444-4444-8444-444444444444';const second=await runtimeSupportReport({...f,input:payload(),sharedOrganizationAgents:true});assert.equal(second.replayed,true);assert.equal(f.sends,1);
 for(const insert of f.calls.filter(c=>c.sql?.startsWith('INSERT')))assert.equal(insert.args[1],user);
});

test('nightly activation requires explicit organization allowlist for context and submit',async()=>{const f=fixture();f.env={SYSTEM_EMAIL_SUPPORT:'support@example.invalid'};await assert.rejects(nightlyRoutineContext(f),/nightly_not_enabled/);await assert.rejects(runtimeSupportReport({...f,input:payload()}),/nightly_not_enabled/);assert.equal(f.sends,0);});

test('only exact persisted native nightly occurrence can authorize a support report',async()=>{
 const row=witness();assert.equal(savedNightlyOccurrence([row],'session-chief',payload().occurrence),true);
 for(const mutate of [r=>r.payload.data.source.kind='user',r=>r.payload.data.source.occurrenceAt='2026-10-09T03:00:00.000Z',r=>r.payload.data.content[0].text=r.payload.data.content[0].text.replace('schedule-','other-'),r=>r.payload.data.content[0].text='reminders_json: invalid']){const changed=structuredClone(row);mutate(changed);assert.equal(savedNightlyOccurrence([changed],'session-chief',payload().occurrence),false);}
 assert.equal(savedNightlyOccurrence([row],'session-other',payload().occurrence),false);
 const f=fixture();const query=f.db.$queryRawUnsafe;f.db.$queryRawUnsafe=(sql,...args)=>sql.includes('FROM hivemind.harness_session_events')?[]:query(sql,...args);
 await assert.rejects(runtimeSupportReport({...f,input:payload()}),/native_nightly_occurrence_required/);assert.equal(f.saved,undefined);assert.equal(f.sends,0);
 await assert.rejects(runtimeSupportReport({...f,input:{operation:'status',occurrence:payload().occurrence}}),/native_nightly_occurrence_required/);
});

test('batched native occurrence is the nightly member, not necessarily the first source occurrence',()=>{
 const row=witness();const data=row.payload.data;const reminders=JSON.parse(data.content[0].text.slice('reminders_json: '.length));
 const first='2026-10-09T01:00:00.000Z';data.source.occurrenceAt=first;
 reminders.unshift({schedule_id:'schedule-55555555-5555-4555-8555-555555555555',occurrence_at:first,reminder_prompt:'Another scheduled native task'});
 data.content[0].text='reminders_json: '+JSON.stringify(reminders);
 assert.equal(savedNightlyOccurrence([row],'session-chief',payload().occurrence),true);
 data.source.occurrenceAt='2026-10-09T04:00:00.000Z';assert.equal(savedNightlyOccurrence([row],'session-chief',payload().occurrence),false);
});

const technical=()=>({owner:'hyperagent',agent_index:1,tool:'hivemind_app_get',expected:'A validated application identifier is discovered before reading.',observed:'The tool rejected an invalid identifier.',recovery:'Discovery was retried with the existing app catalog.',prevention:'Validate the identifier and inspect the returned revision before reading.',evidence:[{kind:'tool_result',turn:3,sequence:42}]});
test('bounded detailed report renders escaped technical sections, authenticated organization and preserved delivery idempotency',async()=>{const f=fixture(),p=payload();p.issues[0].details=technical();p.issues[0].details.observed='<img src=x onerror=alert(1)> was rejected as an invalid value.';await runtimeSupportReport({...f,input:p});await runtimeSupportReport({...f,input:p});assert.equal(f.sends,1);const mail=f.calls.find(c=>c.mail).mail;assert.ok(mail.rendered.text.startsWith('Hi admin, this is Runtime from Test organization'));assert.ok(mail.rendered.html.includes('&lt;img'));assert.ok(!mail.rendered.html.includes('<img'));for(const field of ['Expected','Observed','Recovery','Prevention','Evidence'])assert.ok(mail.rendered.html.includes(field));assert.equal(f.saved.message.issues[0].details.evidence[0].sequence,42);});
test('details reject secrets, URLs, identities, control characters, malformed evidence and oversized prose',()=>{for(const text of ['Bearer secretcredential','password=secretcredential','https://internal.example','a@example.com','22222222-2222-4222-8222-222222222222','x\nrawlog','x'.repeat(1201)]){const p=payload();p.issues[0].details={...technical(),observed:text};assert.throws(()=>validateSupportReport(p,now),/support_detail/);}const p=payload();p.issues[0].details={...technical(),evidence:[{kind:'tool_result',raw:'private logs'}]};assert.throws(()=>validateSupportReport(p,now));});
test('missing authenticated organization name cannot dispatch even a valid report',async()=>{const f=fixture();f.db.organization.findUnique=async()=>null;await assert.rejects(runtimeSupportReport({...f,input:payload()}),/organization_name_required/);assert.equal(f.sends,0);assert.equal(f.saved,undefined);});

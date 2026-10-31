import test from 'node:test';
import assert from 'node:assert/strict';
import { messageAdministrator, validateAdministratorMessage, savedAdministratorRequest, savedAdministratorConnection } from '../../src/harness-chat/runtime-administrator-messages.js';
import { renderRuntimeAdministratorEmail } from '../../src/email/templates/runtime-administrator.js';
const claims={sub:'11111111-1111-4111-8111-111111111111',org_id:'22222222-2222-4222-8222-222222222222',operating_role:'runtime',operating_session:'session-test'};
const input={message_key:'task-result-1',kind:'completion',subject:'Your review is ready',message:'I checked Sofia’s review. It is ready to view.'};
function database({role='admin',active=true,enabled=true,events=[],parents=[]}={}) {
 let row; const db={
  userOrganization:{findUnique:async()=>({role,isActive:active})},user:{findUnique:async()=>({email:'admin@example.com',displayName:'Amar'})},organization:{findUnique:async()=>({name:'SINGULANCE'})},hqRuntime:{findUnique:async()=>({ownerUserId:claims.sub,emailUpdatesEnabled:enabled})},
  $transaction:async fn=>fn(db),
  $queryRawUnsafe:async (sql,...args)=>{
   if(sql.includes('set_config'))return [];
   if(sql.includes('information_schema'))return[{table_schema:'hivemind'},{table_schema:'reset_backup_20261021'}].filter(r=>!sql.includes("table_schema='hivemind'")||r.table_schema==='hivemind');
   if(sql.includes('harness_sessions'))return[{id:claims.operating_session}];
   if(sql.includes('harness_session_events'))return events;
   if(sql.startsWith('INSERT')) {row??={id:'33333333-3333-4333-8333-333333333333',content_hash:args[4],status:'pending',message:JSON.parse(args[5])};return[{id:row.id}];}
   if(sql.startsWith('SELECT receipt'))return parents;
   if(sql.startsWith('SELECT *'))return[{...row}];
   if(sql.includes("status='dispatching'")){row.status='dispatching';return[{id:row.id}];}
   if(sql.startsWith('UPDATE')){row.status=args[1];row.receipt=JSON.parse(args[2]);return[{id:row.id}];}
   throw Error(sql);
  }
 };return db;
}
test('Runtime overlay reuses branded shell and escapes all human text',()=>{
 const r=renderRuntimeAdministratorEmail({companyName:'SINGULANCE <organization>',administratorName:'<Amar>',subject:'Review <ready>',message:'<script>bad()</script>\nYour review is ready.',kind:'approval',conversationUrl:'https://next.singulancelabs.com/hivemind/app/employee/harness',portraitUrl:'https://chat.singulancelabs.com/assets/runtime-computer-c2305f5b.webp'});
 assert.ok(r.html.includes('HIVEMIND / SYSTEM MESSAGE'));assert.ok(r.html.includes('Your AI Chief of Staff'));assert.ok(!r.html.includes('<script>'));assert.ok(r.html.includes('Hi &lt;Amar&gt;, this is Runtime from SINGULANCE &lt;organization&gt;.'));assert.ok(r.text.includes('Hi <Amar>, this is Runtime from SINGULANCE <organization>'));assert.ok(r.html.includes('Opening this email or its link does not grant approval'));assert.ok(r.text.includes('Approve:'));
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

test('typed delegated blocker email is deduplicated and does not grant or resume work',async()=>{
 const blocker={id:'hq-blocker-1',state:'blocked',rootId:claims.operating_session,taskId:'task-16',employeeSessionId:'employee-room',kind:'connection'};
 const db=database({events:[{event_type:'hivemind/hq-delegated-blocker',payload:{data:blocker}}]});
 const request={...input,message_key:`${blocker.id}-user-request`,kind:'approval',request_call_id:blocker.id};
 let sent=0;const send=async()=>{sent++;return{ok:true,provider:'cloudflare',messageId:'cf-blocker'};};
 assert.equal((await messageAdministrator({db,claims,input:request,send})).status,'accepted');
 assert.equal((await messageAdministrator({db,claims,input:request,send})).replayed,true);
 assert.equal(sent,1);assert.equal(blocker.state,'blocked');
 await assert.rejects(messageAdministrator({db,claims,input:{...request,message_key:'other-key'},send}),/native_request_not_found/);
 assert.equal(sent,1);
});

test('thread root is scoped to current org/admin recipient and sender and uses stable subject',async()=>{
 const db=database({parents:[{receipt:{messageId:'opaque-provider-id'}},{receipt:{messageId:'<first@cloudflare.example>'}}]});
 const base=db.$queryRawUnsafe;let checked=false;db.$queryRawUnsafe=async(sql,...args)=>{if(sql.startsWith('SELECT receipt')){checked=true;assert.equal(args[0],claims.org_id);assert.equal(args[1],claims.sub);assert.match(args[2],/^[a-f0-9]{64}$/);assert.match(args[3],/^[a-f0-9]{64}$/);assert.match(sql,/recipientHash/);assert.match(sql,/senderHash/);}return base(sql,...args);};
 const result=await messageAdministrator({db,claims,input,send:async args=>{assert.deepEqual(args.thread,{inReplyTo:'<first@cloudflare.example>'});assert.equal(args.rendered.subject,'SINGULANCE · Runtime updates');return{ok:true,provider:'cloudflare',messageId:'<next@cloudflare.example>',deliveryStatus:'queued'};}});
 assert.equal(checked,true);assert.equal(result.sent,true);assert.equal(result.receipt.deliveryStatus,'queued');
});
test('opaque provider ids cannot become fabricated email thread anchors',async()=>{
 const db=database({parents:[{receipt:{messageId:'opaque-id'}},{receipt:{messageId:'<bad@domain>\r\nBcc: victim@example.com'}}]});
 await messageAdministrator({db,claims,input,send:async args=>{assert.equal(args.thread,undefined);return{ok:true,provider:'cloudflare',messageId:'opaque-current',deliveryStatus:'queued'};}});
});
test('provider acceptance must include Cloudflare message receipt and does not imply approval',async()=>{
 for(const receipt of [{ok:true,provider:'gmail_nango',messageId:'other'},{ok:true,provider:'cloudflare'}]){const result=await messageAdministrator({db:database(),claims,input,send:async()=>receipt});assert.equal(result.sent,false);assert.equal(result.status,'unknown');}
});

const connectionEvents=()=>[{event_type:'hivemind/connected-receipt',payload:{data:{version:1,tool:'connection_authorization',workflowSessionId:'workflow-1',receipt:{status:'connection_required',request_call_id:'call-connect',app_label:'Google Sheets',toolkit:'googlesheets',reason:'Read the finance workbooks for the existing review.',redirect_url:'https://untrusted.invalid/authorize',session_id:'workflow-1'}}}},{event_type:'tool/call',payload:{data:{callId:'call-connect',name:'hivemind_connected_task'}}}];
const connectionMessage=()=>({...input,kind:'approval',request_call_id:'call-connect',message_key:'call-connect-user-request'});
test('Runtime own connection receipt must match originating native call, workflow and pending status',()=>{
 const events=connectionEvents(),msg=connectionMessage();assert.deepEqual(savedAdministratorConnection(events,msg,claims.operating_session),{appLabel:'Google Sheets',reason:'Read the finance workbooks for the existing review.'});assert.equal(savedAdministratorRequest(events,msg,claims.operating_session),true);
 for(const mutate of [e=>e[0].payload.data.receipt.status='ready',e=>e[0].payload.data.version=2,e=>e[0].payload.data.receipt.session_id='other-workflow',e=>e[1].payload.data.name='other_tool',e=>e[0].payload.data.receipt.reason='bad\nreason',e=>e[0].payload.data.receipt.app_label='']){const changed=connectionEvents();mutate(changed);assert.equal(savedAdministratorRequest(changed,msg,claims.operating_session),false);}
 const latest=structuredClone(events[0]);latest.payload.data.receipt.status='ready';assert.equal(savedAdministratorRequest([latest,...events],msg,claims.operating_session),false);
 assert.equal(savedAdministratorRequest(events,{...msg,message_key:'invented'},claims.operating_session),false);
});
test('connection email derives app and purpose from saved receipt, uses authenticated review link, and stays paused',async()=>{
 const events=connectionEvents(),db=database({events});let count=0;
 const send=async args=>{count++;assert.equal(args.to,'admin@example.com');for(const body of [args.rendered.html,args.rendered.text]){assert.ok(body.includes('Connect Google Sheets'));assert.ok(body.includes('Read the finance workbooks'));assert.ok(!body.includes('untrusted.invalid'));assert.ok(body.includes('request=call-connect'));assert.ok(body.includes('Opening an email link never grants'));}return{ok:true,provider:'cloudflare',messageId:'<connect@cf.example>',deliveryStatus:'queued'};};
 await messageAdministrator({db,claims,input:connectionMessage(),send});await messageAdministrator({db,claims,input:connectionMessage(),send});assert.equal(count,1);assert.equal(events[0].payload.data.receipt.status,'connection_required');
});
test('approval action links navigate same authenticated room and carry no authorization token',async()=>{
 const db=database({events:[{event_type:'approval/asked',payload:{data:{callId:'approve-1'}}}]});
 await messageAdministrator({db,claims,input:{...input,kind:'approval',request_call_id:'approve-1'},send:async args=>{for(const action of ['approve','decline']){assert.ok(args.rendered.html.includes(`review=${action}`));assert.ok(args.rendered.text.includes(`review=${action}`));}assert.ok(args.rendered.html.includes('request=approve-1'));assert.ok(!args.rendered.html.includes('token='));return{ok:true,provider:'cloudflare',messageId:'<approval@cf.example>'};}});
});

test('native connection lookup is bound to exact authenticated Runtime room and tenant',async()=>{
 const db=database({events:connectionEvents()});const query=db.$queryRawUnsafe;let checked=false;
 db.$queryRawUnsafe=async(sql,...args)=>{if(sql.includes('harness_session_events')){checked=true;assert.deepEqual(args,[claims.operating_session,claims.org_id,claims.sub,'call-connect']);assert.match(sql,/ORDER BY sequence DESC/);assert.match(sql,/receipt.*request_call_id/);return [];}return query(sql,...args);};
 await assert.rejects(messageAdministrator({db,claims,input:connectionMessage(),send:()=>assert.fail('foreign or absent evidence cannot send')}),/native_request_not_found/);assert.equal(checked,true);
});


test('native composite call IDs retain exact correlation and idempotency in connection email', async()=>{
 const callId='call_JDgKVND63bguINQPhAuHED87|fc_0a4343825314d3d5016acb42d75a3c87d2abf1c5212ef78ebc';
 const events=connectionEvents();events[0].payload.data.receipt.request_call_id=callId;events[1].payload.data.callId=callId;
 const request={...connectionMessage(),request_call_id:callId,message_key:`${callId}-user-request`};
 assert.equal(validateAdministratorMessage(request).request_call_id,callId);
 assert.equal(validateAdministratorMessage(request).message_key,request.message_key);
 assert.equal(savedAdministratorRequest(events,request,claims.operating_session),true);
 const db=database({events});let sent=0;const query=db.$queryRawUnsafe;
 db.$queryRawUnsafe=async(sql,...args)=>{if(sql.includes('harness_session_events'))assert.equal(args[3],callId);return query(sql,...args);};
 const send=async args=>{sent++;assert.ok(args.rendered.text.includes(`request=${encodeURIComponent(callId)}`));return{ok:true,provider:'cloudflare',messageId:'<native-composite@cf.example>',deliveryStatus:'queued'};};
 assert.equal((await messageAdministrator({db,claims,input:request,send})).status,'accepted');
 assert.equal((await messageAdministrator({db,claims,input:request,send})).replayed,true);
 assert.equal(sent,1);assert.equal(events[0].payload.data.receipt.status,'connection_required');
});
test('bounded native identifiers reject injection characters while allowing only the native pipe addition',()=>{
 for(const bad of ['call\r\nBcc:attacker','call/path','call?approval=true','call<script>','call\u0000id','call id',"call' OR 1=1",'x'.repeat(181)]){
  assert.throws(()=>validateAdministratorMessage({...input,request_call_id:bad,kind:'decision'}),/invalid_request_reference/);
  assert.throws(()=>validateAdministratorMessage({...input,message_key:bad}),/invalid_message_identity/);
 }
 assert.equal(validateAdministratorMessage({...input,request_call_id:'x'.repeat(180),kind:'decision'}).request_call_id.length,180);
 assert.equal(validateAdministratorMessage({...input,message_key:'x'.repeat(180)}).message_key.length,180);
});

test('an employee notice names its sender and needs no Runtime request reference',()=>{
  const sender={employee_id:'ebee6f09-62df-4fc7-a8ef-363b961d2ca9',name:'Turing',role:'Sales Operations'};
  const decision=validateAdministratorMessage({message_key:'employee-notice-1',kind:'decision',subject:'Blocked on CRM access',message:'Connect the CRM so I can finish the pipeline.',sender});
  assert.deepEqual(decision.sender,sender);
  assert.equal(decision.request_call_id,undefined);
  assert.throws(()=>validateAdministratorMessage({message_key:'k',kind:'decision',subject:'s',message:'m'}),/native_request_reference_required/);
  for (const bad of [{...sender,employee_id:'nope'},{...sender,name:'Evil <x@y>'},{...sender,extra:1},{...sender,role:'a\nb'}])
    assert.throws(()=>validateAdministratorMessage({message_key:'k',kind:'completion',subject:'s',message:'m',sender:bad}),/invalid_message_sender/);
});

test('an employee notice is signed by the employee and greets the administrator by first name',()=>{
  const r=renderRuntimeAdministratorEmail({companyName:'SINGULANCE',administratorName:'Amar Sai',subject:'Pipeline ready',message:'Ten drafts are saved.',kind:'completion',conversationUrl:'https://next.singulancelabs.com/hivemind/app/employee/harness',portraitUrl:'https://next.singulancelabs.com/p.png',sender:{employee_id:'ebee6f09-62df-4fc7-a8ef-363b961d2ca9',name:'Turing',role:'Sales Operations'}});
  assert.ok(r.html.includes('Hi Amar, this is Turing, your Sales Operations at SINGULANCE.'));
  assert.ok(r.html.includes('Sales Operations · SINGULANCE'));
  assert.ok(!r.html.includes('Your AI Chief of Staff'));
  assert.ok(r.text.startsWith('Turing — SINGULANCE'));
});

test('an employee notice shows the employee avatar from the saved look, name and role', () => {
  const sender={employee_id:'ebee6f09-62df-4fc7-a8ef-363b961d2ca9',name:'Turing',role:'Sales Operations',avatarUrl:'https://api.example.test/v1/public/employee-avatar/x.y.png'};
  const r=renderRuntimeAdministratorEmail({companyName:'SINGULANCE',administratorName:'Amar Sai',subject:'Pipeline ready',message:'Done.',kind:'completion',conversationUrl:'https://next.singulancelabs.com/hivemind/app/employee/harness',portraitUrl:'https://next.singulancelabs.com/p.png',sender});
  assert.ok(r.html.includes('<img src="https://api.example.test/v1/public/employee-avatar/x.y.png" width="56" height="56" alt="Turing"'));
  assert.ok(r.html.includes('Sales Operations · SINGULANCE'));
  assert.ok(!r.html.includes('runtime-computer'));
  const fallback=renderRuntimeAdministratorEmail({companyName:'SINGULANCE',administratorName:'Amar Sai',subject:'s',message:'m',kind:'completion',conversationUrl:'https://next.singulancelabs.com/hivemind/app/employee/harness',portraitUrl:'https://next.singulancelabs.com/p.png',sender:{...sender,avatarUrl:undefined}});
  assert.ok(!fallback.html.includes('<img src="https://api.example'));
  assert.ok(fallback.html.includes('line-height:56px;text-align:center">T</div>'));
});

test('an employee notice looks up the sender look inside the administrator organization only', async () => {
  const sender={employee_id:'ebee6f09-62df-4fc7-a8ef-363b961d2ca9',name:'Turing',role:'Sales Operations'};
  const appearance={version:1,provider:'humation',template:'humation-1',asset_version:'1.0.1',seed:'s',crop:'avatar',selections:{head:'hm1-p-000011',body:'hm1-p-000030',bottom:'hm1-p-000033',item:'hm1-p-000053',glasses:'hm1-p-000056'},colors:{stroke:'171717',hair:'171717',skin:'FFFFFF',clothes:'E9A637',bottom:'283345'},background:'FFF0CC'};
  const previous=process.env.HIVEMIND_EMAIL_AVATAR_SECRET;process.env.HIVEMIND_EMAIL_AVATAR_SECRET='test-secret';
  try {
    const send=async (db,key,employee)=>{let html;let where;db.digitalEmployee={findFirst:async args=>{where=args.where;return employee;}};
      await messageAdministrator({db,claims,input:{message_key:key,kind:'completion',subject:'Pipeline ready',message:'Done.',sender},send:async args=>{html=args.rendered.html;return{ok:true,provider:'cloudflare',messageId:'<id@x>'};},avatarBase:'https://api.example.test'});
      return {html,where};};
    const withLook=await send(database(),'employee-look-1',{policyRules:{appearance}});
    assert.deepEqual(withLook.where,{id:sender.employee_id,orgId:claims.org_id});
    assert.match(withLook.html,/<img src="https:\/\/api\.example\.test\/v1\/public\/employee-avatar\/[^"]+\.png" width="56" height="56" alt="Turing"/);
    assert.ok(!withLook.html.includes(sender.employee_id));
    for (const [key,employee] of [['employee-look-2',null],['employee-look-3',{policyRules:{}}],['employee-look-4',{policyRules:{appearance:{version:1}}}]]) {
      const { html }=await send(database(),key,employee);
      assert.ok(!html.includes('employee-avatar'));assert.ok(html.includes('line-height:56px;text-align:center">T</div>'));
    }
    const failing=database();failing.digitalEmployee={findFirst:async()=>{throw Error('db down');}};let html;
    await messageAdministrator({db:failing,claims,input:{message_key:'employee-look-5',kind:'completion',subject:'s',message:'m',sender},send:async args=>{html=args.rendered.html;return{ok:true,provider:'cloudflare',messageId:'<id@x>'};}});
    assert.ok(html.includes('line-height:56px;text-align:center">T</div>'));
  } finally { if(previous===undefined)delete process.env.HIVEMIND_EMAIL_AVATAR_SECRET;else process.env.HIVEMIND_EMAIL_AVATAR_SECRET=previous; }
});

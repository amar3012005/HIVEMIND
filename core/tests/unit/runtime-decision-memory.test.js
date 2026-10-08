import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOperatingMemory, recallOperatingMemory, saveOperatingMemory } from '../../src/hyperagents/operating-memory.js';
const identity={orgId:'67503d34-97e9-49a8-8c52-8ee30cc7603e',userId:'54f5568b-4d6a-4ae1-9a33-48cb2909d59b',source:'runtime'};
const note={kind:'uncertainty',agent_slug:'runtime',title:'Which customer segment?',summary:'The current evidence does not settle the segment.',idempotency_key:'decision-canary',context:{sessionId:'session-canary',state:'open',priority:90,impact:'Unblocks the next research brief.',evidence:['call:canary']}};
test('Runtime records validate typed metadata, author and provenance',()=>{
 assert.equal(validateOperatingMemory(note,identity).context.priority,90);
 assert.throws(()=>validateOperatingMemory(note,{...identity,source:'agent'}),/runtime_/);
 assert.throws(()=>validateOperatingMemory({...note,agent_slug:'sofia'},identity),/runtime_memory_required/);
 assert.throws(()=>validateOperatingMemory({...note,context:{...note.context,priority:101}},identity),/invalid_runtime_memory_priority/);
 assert.throws(()=>validateOperatingMemory({...note,context:{...note.context,state:'resolved'}},identity),/invalid_runtime_memory_resolution/);
 const agenda={...note,kind:'user_agenda',context:{...note.context,state:'confirmed',confirmationRef:'event:7'}};
 assert.equal(validateOperatingMemory(agenda,identity).kind,'user_agenda');
 assert.throws(()=>validateOperatingMemory({...agenda,context:{...agenda.context,confirmationRef:'inferred'}},identity),/invalid_agenda_confirmation/);
});
test('Ordinary retrieval excludes special records; Runtime supports filtered query-free ranking',async()=>{
 const calls=[];const db={$queryRawUnsafe:async(sql,...args)=>{calls.push({sql,args});return [];}};
 await recallOperatingMemory(db,identity.orgId,{});
 assert.match(calls[0].sql,/m.kind NOT IN \('user_agenda', 'uncertainty'\)/);
 await assert.rejects(recallOperatingMemory(db,identity.orgId,{kind:'uncertainty'}),/runtime_memory_required/);
 const result=await recallOperatingMemory(db,identity.orgId,{kind:'uncertainty',agent_slug:'runtime',state:'open',limit:8},{runtimeUserId:identity.userId});
 assert.equal(result.count,0);
 assert.match(calls[1].sql,/priority'\)::integer DESC/);
 assert.match(calls[1].sql,/author_user_id/);
 assert.ok(calls[1].args.includes('open'));
 assert.ok(!calls[1].sql.includes('to_tsquery'));
});

test('Private Runtime saves accept omitted evidence and impact without approval',()=>{
 const {evidence,impact,...minimal}=note.context;
 assert.equal(validateOperatingMemory({...note,context:minimal},identity).kind,'uncertainty');
 assert.equal(validateOperatingMemory({...note,context:{...minimal,evidence:[],impact:''}},identity).kind,'uncertainty');
 assert.equal(validateOperatingMemory({...note,kind:'user_agenda',context:{...minimal,state:'confirmed',confirmationRef:'event:7'}},identity).kind,'user_agenda');
 assert.throws(()=>validateOperatingMemory({...note,context:{...minimal,evidence:['']}},identity),/invalid_runtime_memory_evidence/);
 assert.throws(()=>validateOperatingMemory({...note,context:{...minimal,impact:42}},identity),/invalid_runtime_memory_impact/);
});

test('explicit agenda topics cannot branch without exact supersession; independent keys remain allowed',async()=>{
 const agenda={...note,kind:'user_agenda',context:{...note.context,state:'confirmed',confirmationRef:'event:7',agendaKey:'sales'}};
 assert.equal(validateOperatingMemory(agenda,identity).context.agendaKey,'sales');
 assert.throws(()=>validateOperatingMemory({...agenda,context:{...agenda.context,agendaKey:'Bad topic'}},identity),/invalid_agenda_key/);
 assert.throws(()=>validateOperatingMemory({...note,context:{...note.context,agendaKey:'sales'}},identity),/invalid_agenda_key/);
 const prior='11111111-1111-4111-8111-111111111111';let locked=false;
 const db={$executeRawUnsafe:async()=>{locked=true;},$queryRawUnsafe:async()=>[{id:prior,idempotency_key:'old'}]};
 await assert.rejects(saveOperatingMemory(db,agenda,identity,{source:'runtime',runtimeTransaction:true}),/agenda_supersession_required/);
 assert.equal(locked,true);
});

test('uncertainty updates reject absent or invalid state before any memory mutation',async()=>{
 const prior='11111111-1111-4111-8111-111111111111';
 let writes=0;
 const db={
  $transaction:async fn=>fn(db),
  $queryRawUnsafe:async()=>{writes++;throw Error('unexpected database access');},
  project:{upsert:async()=>{writes++;}},projectMember:{upsert:async()=>{writes++;}},
 };
 const {state,...context}=note.context;
 for(const value of [undefined,null,'', 'closed']) {
  await assert.rejects(saveOperatingMemory(db,{...note,supersedes_id:prior,context:{...context,...(value===undefined?{}:{state:value})}},identity,{source:'runtime'}),error=>{
   assert.equal(error.message,'invalid_uncertainty_update_state');
   assert.match(error.hint,/resolved, open, or superseded/);
   assert.match(error.hint,/no memory was saved/);
   return true;
  });
 }
 assert.equal(writes,0);
 assert.equal(validateOperatingMemory({...note,supersedes_id:prior},identity).context.state,'open');
});

test('explicit resolved uncertainty saves directly to private memory with a resolved receipt',async()=>{
 const prior='11111111-1111-4111-8111-111111111111';
 const projectId='22222222-2222-4222-8222-222222222222';
 const update={...note,supersedes_id:prior,context:{...note.context,state:'resolved'}};
 let writes=0;
 const db={
  $transaction:async fn=>fn(db),
  project:{upsert:async()=>({id:projectId,name:'Hyper Agents',policy:'private'})},
  projectMember:{upsert:async()=>({})},
  $queryRawUnsafe:async(sql,...args)=>{
   if(sql.includes('FOR UPDATE'))return [{id:prior}];
   if(sql.includes('idempotency_key<>'))return [];
   assert.match(sql,/INSERT INTO hivemind.hyper_agent_operating_memories/);
   writes++;
   return [{id:'33333333-3333-4333-8333-333333333333',kind:args[3],status:args[4],agent_slug:args[5],title:args[10],summary:args[11],context:JSON.parse(args[12])}];
  },
 };
 const result=await saveOperatingMemory(db,update,identity,{source:'runtime'});
 assert.equal(writes,1);
 assert.equal(result.ok,true);
 assert.equal(result.memory.context.state,'resolved');
 assert.equal(result.memory.supersedesId,prior);
});

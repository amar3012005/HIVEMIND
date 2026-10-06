import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOperatingMemory, recallOperatingMemory } from '../../src/hyperagents/operating-memory.js';
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

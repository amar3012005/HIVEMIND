import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeAnsweredAgendaSource, savedNativeAgendaQuestion } from '../../src/harness-chat/runtime-agenda-confirmation.js';
const principal={ userId:'storage-user',actorUserId:'admin-user',orgId:'company',runtimeSessionId:'session-runtime' };
const source={ kind:'user-question-reply',outcome:'answered',callId:'question-one',questionCallId:'question-one',questionEventId:'late-question-one',questionAnswer:true,questionAnswerSubmission:true,authenticatedActor:{ userId:'admin-user',orgId:'company' } };
const call={ name:'ask_user_question',callId:'question-one',arguments:{ questions:[{ id:'direction',question:'Which direction?' }] } };
test('native answer uses exact scoped persisted question call',async()=>{
  let args;
  const tx={ $queryRawUnsafe:async(...input)=>{args=input;return [{payload:{data:call}}];} };
  assert.equal(await savedNativeAgendaQuestion(tx,'hivemind',principal,source,20),true);
  assert.deepEqual(args.slice(1),['session-runtime','company','storage-user',20,'question-one']);
  assert.match(args[0],/sequence<\$4::bigint/);
  assert.match(args[0],/event_type='tool\/call'/);
});
test('rejects untrusted, mismatched, missing or duplicate question correlation',async()=>{
  for(const update of [{kind:'user'},{kind:'agent-message'},{outcome:'pending'},{questionAnswer:false},{questionAnswerSubmission:false},{questionCallId:'wrong'},{questionEventId:'wrong'},{authenticatedActor:{userId:'other',orgId:'company'}},{authenticatedActor:{userId:'admin-user',orgId:'other'}}]) {
    let queried=false;
    assert.equal(await savedNativeAgendaQuestion({$queryRawUnsafe:async()=>{queried=true;return[];}},'hivemind',principal,{...source,...update},20),false);
    assert.equal(queried,false);
  }
  for(const rows of [[],[{payload:{data:{...call,callId:'other'}}}],[{payload:{data:{...call,name:'request_permission'}}}],[{payload:{data:{...call,arguments:{questions:[]}}}}],[{payload:{data:call}},{payload:{data:call}}]]) {
    assert.equal(await savedNativeAgendaQuestion({$queryRawUnsafe:async()=>rows},'hivemind',principal,source,20),false);
  }
});
test('requires the authenticated actor even outside shared storage',()=>{
  assert.equal(nativeAnsweredAgendaSource(source,'admin-user','company'),true);
  assert.equal(nativeAnsweredAgendaSource(source,'storage-user','company'),false);
});

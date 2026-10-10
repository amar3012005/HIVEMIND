import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRuntimeAttention } from '../../src/connectors/composio/runtime-attention.js';

const event = { id: 'event', org_id: 'org', user_id: 'user', subscription_id: 'sub', toolkit: 'slack', data: { text: 'A buyer decision changed.' } };
const consent = { enabled: true, orgId: 'org', userId: 'user', subscriptionId: 'sub' };
const snapshot = { orgId: 'org', userId: 'user', sessionId: 'native-room', revision: 'receipt', enabled: true, goals: ['Buyer validation'], decisionMemory: { ready: true, revision: 'private-v1', userAgenda: [{ id:'agenda',title:'Buyer validation',summary:'Confirm qualified buyers',state:'confirmed' }], uncertainties: [] } };
const evaluate = (choice, overrides = {}) => assessRuntimeAttention({ event, consent, snapshot,
  provider: { decideChoice: async () => ({ choice, probability: 0.9, margin: 0.5 }) }, ...overrides });

test('default off performs no decision or delivery', async () => {
  let calls = 0;
  const result = await evaluate('wake', { consent: undefined, provider: { decideChoice: () => { calls++; } } });
  assert.equal(result.action, 'retain'); assert.equal(calls, 0);
});
test('tenant, user and subscription scope are exact', async () => {
  for (const changed of [{ org_id: 'other' }, { user_id: 'other' }, { subscription_id: 'other' }]) {
    assert.equal((await evaluate('wake', { event: { ...event, ...changed } })).reason, 'scope_mismatch');
  }
});
test('missing or foreign native snapshot cannot wake', async () => {
  assert.equal((await evaluate('wake', { snapshot: undefined })).action, 'retain');
  assert.equal((await evaluate('wake', { snapshot: { ...snapshot, userId: 'other' } })).action, 'retain');
});
test('paused Runtime can retain or notify but never be woken by a decision', async () => {
  assert.equal((await evaluate('wake', { snapshot: { ...snapshot, enabled: false } })).action, 'retain');
  assert.equal((await evaluate('notify', { snapshot: { ...snapshot, enabled: false } })).action, 'notify');
});
test('three attention choices remain distinct; notify never invokes agent delivery', async () => {
  for (const action of ['retain', 'notify', 'wake']) assert.equal((await evaluate(action)).action, action);
});
test('invalid, uncertain and failed decisions retain quietly', async () => {
  for (const decision of [{ choice: 'execute', probability: 1, margin: 1 }, { choice: 'wake', probability: 0.44, margin: 1 },
    { choice: 'wake', probability: NaN, margin: 1 }, { choice: 'wake', probability: 1, margin: 0.04 }]) {
    assert.equal((await evaluate('wake', { provider: { decideChoice: async () => decision } })).action, 'retain');
  }
  assert.equal((await evaluate('wake', { provider: { decideChoice: async () => { throw Error('offline'); } } })).reason, 'decision_unavailable');
});
test('bounded untrusted projection excludes raw credentials and provider identifiers', async () => {
  let request;
  await evaluate('wake', { event: { ...event, data: { text: 'x'.repeat(2000), api_key: 'secret' } },
    provider: { decideChoice: async value => { request = value; return { choice: 'retain', probability: 1, margin: 1 }; } } });
  assert.equal(request.state.source_is_untrusted, true);
  assert.equal(request.state.event.preview.length, 900);
  assert.ok(!JSON.stringify(request).includes('secret'));
});

test('missing, conflicted or truncated private direction never reaches model', async () => {
  for (const decisionMemory of [undefined, { ready:false,agendaConflict:true }]) {
    let calls=0;
    const result=await evaluate('wake',{ snapshot:{...snapshot,decisionMemory},provider:{decideChoice:()=>{calls++;}} });
    assert.equal(result.reason,'decision_memory_unavailable'); assert.equal(calls,0);
  }
});
test('typed direction stays whole and decision records its private revision', async () => {
  let request;
  const result=await evaluate('wake',{provider:{decideChoice:async value=>{request=value;return {choice:'wake',probability:0.9,margin:0.5};}}});
  assert.deepEqual(request.state.runtime.decisionMemory,snapshot.decisionMemory);
  assert.equal(result.decisionMemoryRevision,'private-v1');
  assert.match(request.instructions,/dates alone do not establish/);
});

test('activation watermark retains old events; explicit shadow results cannot be admitted', async () => {
 const dated={...event,received_at:'2026-10-01T00:00:00Z'};
 const windowed={...snapshot,admissionWindow:{notBefore:'2026-10-08T00:00:00Z'}};
 assert.equal((await evaluate('wake',{event:dated,snapshot:windowed})).reason,'before_activation');
 const shadow=await evaluate('wake',{event:dated,snapshot:windowed,mode:'shadow'});
 assert.equal(shadow.shadow,true);assert.equal(shadow.policy,'runtime_attention_v2_shadow');assert.equal(shadow.action,'wake');
});

test('shadow low confidence and provider failures stay explicitly shadow', async () => {
 for(const provider of [{decideChoice:async()=>({choice:'wake',probability:0.44,margin:0.27})},{decideChoice:async()=>{throw Error('fixture provider down');}}]){
  const result=await evaluate('wake',{provider,mode:'shadow'});
  assert.equal(result.action,'retain');assert.equal(result.policy,'runtime_attention_v2_shadow');assert.equal(result.shadow,true);
 }
});


test('whole native context and the complete policy reach the decision boundary', async () => {
 let request;
 const extra={...snapshot,goals:[{id:'g',objective:'known direction'}],tasks:[{id:'t',status:'pending',description:'q'.repeat(250)}],pendingDecisions:[{summary:'s'.repeat(600),nextSteps:['n'.repeat(180),'n'.repeat(180)],blockers:['b'.repeat(180)]}],company:{name:'Isolated example'}};
 await evaluate('wake',{snapshot:extra,provider:{decideChoice:async value=>{request=value;return {choice:'retain',probability:.9,margin:.5};}}});
 for(const key of ['goals','tasks','pendingDecisions','company']) assert.deepEqual(request.state.runtime[key],extra[key]);
 assert.ok(request.instructions.length<=1000,'provider cap must not remove policy');
 for(const phrase of ['fresh exact match','pending native task','Completed work','Independent agendas','Contradictory confirmed','Preserve user approval limits']) assert.ok(request.instructions.includes(phrase),phrase);
 assert.deepEqual(request.state.runtime.decisionMemory,extra.decisionMemory);
 assert.match(request.options.find(o=>o.id==='wake').criteria,/confirmed conditional agenda and pending native task/);
});

test('attention context budget failure remains quiet and distinguishable', async()=>{
 for(const message of ['attention_context_projection_loss','decision_state_exceeds_budget']) {
  const result=await evaluate('wake',{provider:{decideChoice:async()=>{throw Error(message)}}});
  assert.equal(result.action,'retain');assert.equal(result.reason,'decision_context_unavailable');
 }
});

test('broad attention admits moderate-confidence company signals and does not silence weak retain decisions', async () => {
 for (const choice of ['wake', 'notify']) {
  const result = await evaluate(choice, { provider: { decideChoice: async () => ({ choice, probability: 0.55, margin: 0.1 }) } });
  assert.equal(result.action, choice);
 }
 const unclear = await evaluate('retain', { provider: { decideChoice: async () => ({ choice: 'retain', probability: 0.59, margin: 0.23 }) } });
 assert.equal(unclear.action, 'wake');
 const promotion = await evaluate('retain', { provider: { decideChoice: async () => ({ choice: 'retain', probability: 0.9, margin: 0.6 }) } });
 assert.equal(promotion.action, 'retain');
});

import test from 'node:test';import assert from 'node:assert/strict';import {runAccountErasureOnce} from '../../src/security/account-erasure-worker.js';
const userId='11111111-1111-1111-1111-111111111111';const workerId='22222222-2222-2222-2222-222222222222';
function fixture({shared=false,unknown=false,reconciled=false,missing=false}={}) {
 const op={id:'33333333-3333-3333-3333-333333333333',user_id:userId,actor_id:userId,confirmation:'DELETE',state:reconciled?'reconciled':'processing',ownership_snapshot:{organizations:shared?[{orgId:'company',disposition:'retain_shared',remainingMembers:[{userId:'other',role:'member'}]}]:[]}};const removed=[];
 const db={$transaction:fn=>fn(db),$executeRawUnsafe:async()=>1,$queryRawUnsafe:async sql=>sql.includes('WITH candidate')?[op]:sql.includes('count(*)')?[{count:unknown?1:0}]:[{id:op.id}],user:{findUnique:async()=>missing?null:{id:userId}},userOrganization:{findMany:async query=>query.where.userId===userId?(shared?[{orgId:'company',role:'member'}]:[]):[{userId:'other',role:'member'}],count:async()=>0},memory:{count:async()=>shared?1:0}};
 for(const name of ['knowledgeIngestJob','knowledgeDocument','sourceArtifact','knowledgeSegment','documentTable','memoryEvidenceLink'])db[name]={findMany:async()=>[],count:async()=>0,deleteMany:async()=>{removed.push(name);}};
 return{db,removed};
}
test('shared company and unknown provider work block without destructive actions',async()=>{for(const args of [{shared:true},{unknown:true}]){const{db,removed}=fixture(args);let finalized=false;const result=await runAccountErasureOnce({prisma:db,workerId,finalize:async()=>{finalized=true;return{ok:true};}});assert.equal(result.status,'blocked');assert.deepEqual(removed,[]);assert.equal(finalized,false);}});
test('exclusive empty source class reconciles before finalization',async()=>{const{db,removed}=fixture();let finalized=false;const result=await runAccountErasureOnce({prisma:db,workerId,finalize:async()=>{assert.equal(removed.length,3);finalized=true;return{ok:true};}});assert.equal(result.status,'completed');assert.equal(finalized,true);});
test('crash after final identity deletion can complete a reconciled operation without replay',async()=>{const{db}=fixture({reconciled:true,missing:true});let replay=false;const result=await runAccountErasureOnce({prisma:db,workerId,finalize:async()=>{replay=true;}});assert.equal(result.status,'completed');assert.equal(replay,false);});
test('administrator erasure stops when the confirmed email has changed',async()=>{
 const {erasureEmailHash}=await import('../../src/security/account-erasure-authority.js');const {db,removed}=fixture();
 const authority={kind:'platform_admin',operator:'admin',sessionId:workerId,userId,targetEmailHash:erasureEmailHash('original@example.com')};
 const original=db.$queryRawUnsafe;db.$queryRawUnsafe=async(sql,...args)=>sql.includes('WITH candidate')?[{id:'33333333-3333-3333-3333-333333333333',user_id:userId,actor_id:workerId,confirmation:'DELETE',state:'processing',ownership_snapshot:{organizations:[],platformAdmin:authority}}]:original(sql,...args);
 db.user.findUnique=async()=>({id:userId,email:'changed@example.com'});let finalized=false;
 const result=await runAccountErasureOnce({prisma:db,workerId,finalize:async()=>{finalized=true;return{ok:true};}});
 assert.equal(result.code,'ERASURE_EMAIL_CHANGED');assert.deepEqual(removed,[]);assert.equal(finalized,false);
});
test('temporary catalog outage schedules automatic recovery without discarding identity',async()=>{
 const {db,removed}=fixture();let retry=null,finalized=false;const original=db.$executeRawUnsafe;
 db.$executeRawUnsafe=async(sql,...args)=>{if(sql.includes("failure_code=$3"))retry=args[3];return original(sql,...args)};
 const result=await runAccountErasureOnce({prisma:db,workerId,eraseNative:async()=>{throw Object.assign(Error('catalog unavailable'),{code:'COMPOSIO_ERASURE_UNAVAILABLE'})},finalize:async()=>{finalized=true}});
 assert.equal(result.code,'COMPOSIO_ERASURE_UNAVAILABLE');assert.equal(retry,30);assert.equal(finalized,false);assert.deepEqual(removed,[]);
});
test('trigger and Runtime steps run before finalization and a failure in either blocks and retries',async()=>{
 const{db}=fixture();const order=[];
 const ok=await runAccountErasureOnce({prisma:db,workerId,eraseTriggers:async({userId:id})=>{assert.equal(id,userId);order.push('triggers');return{disabled:1,alreadyGone:0,sharedKept:0,removed:1};},eraseRuntime:async input=>{assert.equal(input.userId,userId);order.push('runtime');return{verified:true,operationId:input.operationId,archivedSessions:2,removedWakes:1};},finalize:async()=>{order.push('finalize');return{ok:true};}});
 assert.equal(ok.status,'completed');assert.deepEqual(order,['triggers','runtime','finalize']);
 for(const failing of ['eraseTriggers','eraseRuntime']){
  const{db}=fixture();let finalized=false;
  const steps={eraseTriggers:async()=>({disabled:0,alreadyGone:0,sharedKept:0,removed:0}),eraseRuntime:async input=>({verified:true,operationId:input.operationId,archivedSessions:0,removedWakes:0})};
  steps[failing]=async()=>{throw Object.assign(new Error('down'),{code:failing==='eraseTriggers'?'COMPOSIO_TRIGGER_ERASURE_UNAVAILABLE':'RUNTIME_ERASURE_UNAVAILABLE'});};
  const result=await runAccountErasureOnce({prisma:db,workerId,...steps,finalize:async()=>{finalized=true;return{ok:true};}});
  assert.equal(result.status,'blocked');assert.equal(finalized,false);
 }
});

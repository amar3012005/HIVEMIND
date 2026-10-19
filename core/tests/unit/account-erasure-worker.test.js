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

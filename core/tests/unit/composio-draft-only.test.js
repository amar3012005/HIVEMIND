import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDraftOnly } from '../../src/connectors/composio/draft-only-execution.js';
import { issueGovernedToolGrant, resolveGovernedToolGrant } from '../../src/connectors/composio/runtime-adapter.js';

function fixture() {
 const row={id:'operation',orgId:'org',userId:'user',provider:'composio',toolName:'GMAIL_CREATE_EMAIL_DRAFT',status:'draft',argsHash:'exact-args',expiresAt:new Date(Date.now()+60000)};
 const prisma={pendingWrite:{async updateMany({where,data}){if(row.status!==where.status)return {count:0};Object.assign(row,data);return {count:1}},async update({data}){Object.assign(row,data);return row}}};
 return {row,prisma,orgId:'org',userId:'user'};
}
test('only exact draft creation receives a signed no-approval policy',()=>{
 for(const slug of ['GMAIL_CREATE_EMAIL_DRAFT','GMAIL_SEND_DRAFT','GMAIL_SEND_EMAIL','GMAIL_DELETE_DRAFT']){
  const params={orgId:'org',userId:'user',toolkit:'gmail',sessionId:'session',toolSlug:slug};
  const issued=issueGovernedToolGrant(params,{secret:'fixture'});
  const grant=resolveGovernedToolGrant({...params,grantId:issued.grantId},{secret:'fixture'});
  assert.equal(grant.effect,'write');assert.equal(grant.approvalRequired,slug!=='GMAIL_CREATE_EMAIL_DRAFT');
 }
});
test('draft write executes once and returns the durable saved receipt on replay',async()=>{
 const f=fixture();let calls=0;const execute=async()=>{calls++;return {successful:true,data:{id:'gmail-draft'}}};
 const first=await executeDraftOnly({...f,execute});const second=await executeDraftOnly({...f,execute});
 assert.equal(calls,1);assert.equal(first.status,'completed');assert.equal(second.replayed,true);assert.equal(second.data.id,'gmail-draft');assert.equal(f.row.approvedAt,undefined);
});
test('concurrent draft execution claims the action once',async()=>{
 const f=fixture();let calls=0;const execute=async()=>{calls++;return {successful:true,data:{id:'draft'}}};
 await Promise.all([executeDraftOnly({...f,row:{...f.row},execute}),executeDraftOnly({...f,row:{...f.row},execute})]);assert.equal(calls,1);
});
test('unknown provider outcome remains paused, never repeated after retry',async()=>{
 const f=fixture();let calls=0;const execute=async()=>{calls++;throw Error('connection reset after request')};
 assert.equal((await executeDraftOnly({...f,execute})).status,'reconciliation_required');
 assert.equal((await executeDraftOnly({...f,execute})).status,'reconciliation_required');assert.equal(calls,1);
});
test('send and cross-user attempts are denied before any provider action',async()=>{
 let calls=0;const execute=async()=>{calls++};const f=fixture();
 await assert.rejects(executeDraftOnly({...f,userId:'other',execute}),/scope_denied/);
 await assert.rejects(executeDraftOnly({...f,row:{...f.row,toolName:'GMAIL_SEND_DRAFT'},execute}),/scope_denied/);assert.equal(calls,0);
});

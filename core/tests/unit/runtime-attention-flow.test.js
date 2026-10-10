import test from 'node:test';import assert from 'node:assert/strict';
import {classifyPendingActivity} from '../../src/connectors/composio/activity-relevance.js';
let sequence=0;
async function run(action='notify',{failed=false,prior,data={text:'ordinary user activity'}}={}){
 const writes=[],calls=[],notifications=[],orgId=`org-${++sequence}`,row={id:'event',subscription_id:'sub',org_id:orgId,user_id:'user',received_at:'2026-10-04T12:00:00Z',data,relevance_decision:prior};
 const db={userOrganization:{findUnique:async()=>({isActive:true})},workspaceNotification:{upsert:async args=>{notifications.push(args);return {id:'notice'}}},$queryRawUnsafe:async sql=>sql.includes('UPDATE hivemind_trigger_events')?[row]:[{toolkit:'slack',runtime_attention:true,runtime_attention_enabled_at:'2026-10-04T11:00:00Z'}],$executeRawUnsafe:async(sql,...args)=>writes.push({sql,args})};
 await classifyPendingActivity({orgId,userId:'user',allowedAccountIds:['account'],prisma:db,runtimeAttention:{assess:async event=>{calls.push(['assess',event.id]);return {policy:'runtime_attention_v3',action,targetSessionId:'runtime',contextRevision:'current'}},deliver:async()=>{calls.push(['deliver']);if(failed)throw Error('unknown');return {status:'accepted',targetSessionId:'runtime',inboxPersisted:true}}}});
 return {writes,calls,notifications};
}
test('all authorized topics reach native decision, without Core topical prefilter',async()=>{for(const text of ['promotion','personal chat topic','verification code 123','company work']){const r=await run('retain',{data:{text}});assert.deepEqual(r.calls,[['assess','event']]);assert.equal(r.notifications.length,0)}});
test('notify and wake persist native admission and visible notification independently',async()=>{for(const action of ['notify','wake']){const r=await run(action);assert.deepEqual(r.calls,[['assess','event'],['deliver']]);assert.equal(r.notifications[0].create.data.inboxPersisted,true);assert.equal(r.notifications[0].create.data.wakeRequested,action==='wake');assert.equal(r.notifications[0].create.resourceId,'runtime');assert.match(r.writes[1].sql,/runtimeDelivery/)}});
test('unknown native delivery stays pending and produces no false notification',async()=>{const r=await run('notify',{failed:true});assert.match(r.writes.at(-1).sql,/relevance_status='pending'/);assert.equal(r.notifications.length,0)});

test('retry reuses recorded native admission without reclassifying',async()=>{const r=await run('notify',{prior:{runtimeAttention:{policy:'runtime_attention_v3',action:'notify',targetSessionId:'runtime'}}});assert.deepEqual(r.calls,[['deliver']]);assert.equal(r.notifications.length,1)});

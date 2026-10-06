import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAppRuntimePrincipal,isAllowedAppRuntimeOperation } from '../../src/app-runtime/access.js';
import { createPostgresAppRuntimeTransactionRunner } from '../../src/app-runtime/postgres-transaction.js';
import { forwardAppRuntimeRequest } from '../../src/app-runtime/gateway.js';
const app='11111111-1111-4111-8111-111111111111';
const org='22222222-2222-4222-8222-222222222222';
const user='33333333-3333-4333-8333-333333333333';
const principal={orgId:org,userId:user,scopes:['mcp']};
test('CRM requires unscoped user authority and relevant credential scope',()=>{
  assert.equal(assertAppRuntimePrincipal(principal),principal);
  for(const restricted of [{projectId:app},{teamId:app},{isServiceKey:true},{containerTags:['private']},{scopes:['memory:read']}]) {
    assert.throws(()=>assertAppRuntimePrincipal({...principal,...restricted}),e=>e.code==='forbidden');
  }
  assert.throws(()=>assertAppRuntimePrincipal({}),e=>e.code==='unauthorized');
  assertAppRuntimePrincipal({...principal,scopes:['app:read']},'GET');
  assert.throws(()=>assertAppRuntimePrincipal({...principal,scopes:['app:read']},'POST'),e=>e.code==='forbidden');
});
test('Gateway only allows explicit methods/UUID routes',()=>{
  assert.equal(isAllowedAppRuntimeOperation(`/api/app-runtime/apps/${app}/published`,'GET'),true);
  assert.equal(isAllowedAppRuntimeOperation(`/api/app-runtime/apps/${app}/workflows`,'GET'),true);
  for(const [path,method] of [['/api/app-runtime/apps/../../memories','GET'],[`/api/app-runtime/apps/${app}`,'DELETE'],[`/api/app-runtime/apps/${app}/workflows`,'POST']]) assert.equal(isAllowedAppRuntimeOperation(path,method),false);
});
test('PostgreSQL adapter bounds transactions and rejects RLS bypass roles',async()=>{
  const calls=[];
  let releases=0;
  let bypass=false;
  const run=createPostgresAppRuntimeTransactionRunner({connect:async()=>({query:async(sql,values)=>{calls.push([sql,values]);return {rows:sql.includes('pg_roles')?[{rolsuper:false,rolbypassrls:bypass}]:[{n:1}]};},release:()=>{releases++;}})});
  await run(principal,async db=>{assert.deepEqual(await db.query('SELECT $1::int AS n',[1]),{rows:[{n:1}]});});
  assert.equal(calls[0][0],'BEGIN');assert.equal(calls.at(-1)[0],'COMMIT');
  assert.ok(calls.some(([sql,values])=>sql==='SELECT $1::int AS n'&&values[0]===1));
  bypass=true;
  await assert.rejects(()=>run(principal,()=>assert.fail('Must reject bypass role')),e=>e.code==='unavailable');
  assert.equal(calls.at(-1)[0],'ROLLBACK');assert.equal(releases,2);
});
test('Gateway forwards only verified claims, preserves result and does not retry writes',async()=>{
  let output;let request;let calls=0;
  const args={req:{method:'POST',url:'/internal/v1/harness-chat/core/api/app-runtime/apps',headers:{'x-hm-org-id':'forged'}},res:{},corePath:'/api/app-runtime/apps',claims:{sub:user,org_id:org},env:{HIVE_APP_RUNTIME_ENABLED:'true'},coreApiBaseUrl:'http://127.0.0.1:55555',internalApiKey:'fixture-only',parseBody:async()=>({operationId:'demo',spec:{}}),jsonResponse:(_res,value,status)=>{output={value,status};},fetchImpl:async(_url,options)=>{calls++;request=options;return {status:200,text:async()=>JSON.stringify({app:{id:app}})};}};
  await forwardAppRuntimeRequest(args);assert.equal(request.headers['x-hm-org-id'],org);assert.equal(request.headers['x-hm-user-id'],user);assert.equal(output.status,200);assert.equal(calls,1);
  await forwardAppRuntimeRequest({...args,claims:{...args.claims,project_id:app}});assert.equal(output.status,403);assert.equal(calls,1);
  await forwardAppRuntimeRequest({...args,fetchImpl:async()=>{calls++;throw new Error('timeout')}});assert.equal(output.status,503);assert.equal(calls,2);assert.match(output.value.error.message,/same operation ID/);
});
test('Gateway cancels an oversized upstream stream before buffering it all',async()=>{
  let cancelled=false;let output;
  await forwardAppRuntimeRequest({req:{method:'GET',url:'/internal/v1/harness-chat/core/api/app-runtime/apps'},res:{},corePath:'/api/app-runtime/apps',claims:{sub:user,org_id:org},env:{HIVE_APP_RUNTIME_ENABLED:'true'},coreApiBaseUrl:'http://127.0.0.1:55555',internalApiKey:'fixture-only',jsonResponse:(_r,value,status)=>{output={value,status};},fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1024*1024+1));},cancel(){cancelled=true;}}))});
  assert.equal(cancelled,true);assert.equal(output.status,503);
});

test('Locked app reads refresh the immutable version snapshot after acquiring the row lock', async () => {
  const {AppRuntimeStore}=await import('../../src/app-runtime/store.js');
  const queries=[];const row={id:'10000000-0000-4000-8000-000000000001',current_version:2,published_version:1,spec:{name:'Updated'}};
  const db={query:async(sql)=>{queries.push(sql);return {rows:[queries.length===1?{id:row.id}:row]};}};
  const store=new AppRuntimeStore({transactionRunner:async()=>{}});
  assert.equal((await store.readApp(db,{orgId:row.id},row.id,{lock:true})).current_version,2);
  assert.match(queries[0],/FOR UPDATE$/);assert.doesNotMatch(queries[0],/JOIN/);
  assert.match(queries[1],/JOIN hivemind.app_runtime_versions/);assert.doesNotMatch(queries[1],/FOR UPDATE/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {AppRuntimeStore} from '../../src/app-runtime/store.js';
import {createAppRuntimeHandler} from '../../src/app-runtime/routes.js';
const org='22222222-2222-4222-8222-222222222222';
const user='33333333-3333-4333-8333-333333333333';
const principal={orgId:org,userId:user};
const ids=[1,2,3].map(i=>`11111111-1111-4111-8111-${String(i).padStart(12,'0')}`);
function fixture(role='org_admin') {
  const queries=[];
  const rows=ids.map((id,i)=>({id,current_version:i+2,published_version:i+1,name:i===2?'Other':'Sales CRM',created_at:'2026-10-08T00:00:00Z',updated_at:'2026-10-08T01:00:00Z'}));
  const runner=async(_p,body)=>body({query:async(sql,args)=>{
    queries.push({sql,args});
    if(sql.includes('app_runtime_lock_membership')) return {rows:[{role,roles:[role],is_active:true}]};
    if(sql.startsWith('SELECT a.id')) {
      assert.equal(args[0],org);
      return {rows: args.length===1?rows:rows.filter(r=>(!args[1]||r.id>args[1])&&(!args[2]||r.name.toLowerCase().includes(args[2].toLowerCase()))).slice(0,args[3])};
    }
    return {rows:[]};
  }});
  return {queries,runner,store:new AppRuntimeStore({transactionRunner:runner})};
}
test('admin discovery pages literal name matches and returns exact UUID/current versions',async()=>{
  const f=fixture();
  const first=await f.store.list(principal,{limit:1,query:' CRM '});
  assert.equal(first.apps[0].id,ids[0]);assert.equal(first.apps[0].version,2);assert.equal(first.nextCursor,ids[0]);
  const second=await f.store.list(principal,{limit:1,query:'CRM',after:first.nextCursor});
  assert.equal(second.apps[0].id,ids[1]);assert.equal(second.nextCursor,null);
  const calls=f.queries.filter(q=>q.sql.startsWith('SELECT a.id'));
  assert.match(calls[0].sql,/a.org_id=\$1::uuid/);assert.match(calls[0].sql,/ORDER BY a.id LIMIT \$4/);
  assert.match(calls[0].sql,/strpos/);assert.deepEqual(calls[0].args,[org,null,'CRM',2]);
  const published=await f.store.list(principal,{limit:2,published:true});
  assert.equal(published.apps[0].version,1);assert.equal(published.apps[0].publishedVersion,1);
  assert.match(f.queries.at(-1).sql,/v.version=a.published_version/);
});
test('legacy list remains read-only compatible while authoring discovery requires active admin',async()=>{
  const f=fixture('viewer');const legacy=await f.store.list(principal);
  assert.deepEqual(Object.keys(legacy),['apps','truncated']);assert.equal(legacy.apps.length,3);
  assert.match(f.queries.at(-1).sql,/ORDER BY a.updated_at DESC,a.id LIMIT 101/);
  await assert.rejects(()=>f.store.list(principal,{limit:25}),e=>e.code==='forbidden');
  assert.equal(f.queries.filter(q=>q.sql.startsWith('SELECT a.id')).length,1);
});
test('invalid query/cursor/budget never reaches the discovery query',async()=>{
  const f=fixture();
  for(const options of [{limit:0},{limit:26},{limit:1.2},{query:''},{query:'x'.repeat(121)},{after:'CRM'}]) {
    await assert.rejects(async()=>f.store.list(principal,options),e=>e.code==='invalid_arguments');
  }
  assert.equal(f.queries.length,0);
});
test('existing list route forwards validated paging and refuses model-authored identities',async()=>{
  const f=fixture();let output;
  const handler=createAppRuntimeHandler({transactionRunner:f.runner,resolvePrincipal:async()=>principal,jsonResponse:(_r,value,status)=>{output={value,status};}});
  await handler({req:{method:'GET',url:'/api/app-runtime/apps?query=CRM&limit=1'},res:{}});
  assert.equal(output.status,200);assert.equal(output.value.nextCursor,ids[0]);
  for(const query of ['org_id=other','limit=1&limit=2','published=false','limit=1.2','after=CRM']) {
    await handler({req:{method:'GET',url:`/api/app-runtime/apps?${query}`},res:{}});
    assert.equal(output.status,400);
  }
});

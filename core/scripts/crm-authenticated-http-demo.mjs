/** Actual Core + Control HTTP proof. Artificial isolated fixture only, no admission bypass. */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const fixturePath='/tmp/hivemind-crm-authenticated-preview-20261006/auth.json';
const f=JSON.parse(await fs.readFile(fixturePath,'utf8'));
const core='http://127.0.0.1:63001',cp='http://127.0.0.1:63002';
const checks=[];const prefix='/api/app-runtime/apps';const proxy='/v1/proxy/app-runtime/apps';
const key=n=>({Authorization:`Bearer ${f[n].apiKey}`});const cookie=n=>({Cookie:f[n].cookie});
async function call(base,path,headers={},method='GET',body){const r=await fetch(base+path,{headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},method,body:body?JSON.stringify(body):undefined});let data;try{data=await r.json();}catch{data={};}return {status:r.status,data};}
async function check(name,promise,status){const r=await promise;assert.equal(r.status,status,`${name}: ${r.status} ${JSON.stringify(r.data).slice(0,200)}`);checks.push({name,status});return r.data;}
const run=crypto.randomUUID();
const spec={schemaVersion:1,name:'Synthetic Enterprise CRM',entities:[{id:'company',name:'Companies',fields:[{id:'name',name:'Company name',type:'text',required:true},{id:'stage',name:'Stage',type:'enum',options:['New','Qualified']}]},{id:'deal',name:'Deals',fields:[{id:'name',name:'Deal name',type:'text',required:true},{id:'company',name:'Company',type:'reference',targetEntityId:'company'}]}],views:[{id:'companies',name:'Companies',type:'table',entityId:'company',fieldIds:['name','stage']},{id:'pipeline',name:'Pipeline',type:'kanban',entityId:'company',groupByFieldId:'stage'},{id:'company-detail',name:'Company details',type:'record',entityId:'company'}]};
await check('Core missing key',call(core,prefix),401);
await check('Core invalid key',call(core,prefix,{Authorization:'Bearer invalid-synthetic'}),401);
await check('Core unrelated scoped key',call(core,prefix,{Authorization:`Bearer ${f.unrelatedApiKey}`}),403);
await check('Core project key denied',call(core,prefix,{Authorization:`Bearer ${f.projectApiKey}`}),403);
await check('Control missing cookie',call(cp,proxy),401);
await check('Control invalid signed cookie',call(cp,proxy,{Cookie:'hm_cp_session=invalid'}),401);
const {app}=await check('Native key creates draft',call(core,prefix,key('1'),'POST',{spec,operationId:`${run}-create`}),200);
const replay=await check('Idempotent draft replay',call(core,prefix,key('1'),'POST',{spec,operationId:`${run}-create`}),200);assert.equal(replay.app.id,app.id);
await check('Idempotency payload conflict',call(core,prefix,key('1'),'POST',{spec:{...spec,name:'Other'},operationId:`${run}-create`}),409);
await check('Draft validates',call(core,`${prefix}/${app.id}/validate`,key('1'),'POST',{}),200);
await check('Draft publishes',call(core,`${prefix}/${app.id}/publish`,key('1'),'POST',{expectedVersion:1,operationId:`${run}-publish`}),200);
const {record}=await check('Company record creates',call(core,`${prefix}/${app.id}/records`,key('1'),'POST',{entityId:'company',data:{name:'Synthetic Acme',stage:'New'},operationId:`${run}-company`}),200);
await check('Typed same-app reference',call(core,`${prefix}/${app.id}/records`,key('1'),'POST',{entityId:'deal',data:{name:'Artificial deal',company:record.id},operationId:`${run}-deal`}),200);
await check('Record partial update',call(core,`${prefix}/${app.id}/records/${record.id}`,key('1'),'PATCH',{expectedVersion:1,data:{stage:'Qualified'},operationId:`${run}-update`}),200);
await check('Record optimistic conflict',call(core,`${prefix}/${app.id}/records/${record.id}`,key('1'),'PATCH',{expectedVersion:1,data:{stage:'New'},operationId:`${run}-stale`}),409);
await check('Foreign key app hidden',call(core,`${prefix}/${app.id}`,key('2')),404);
await check('Native signed cookie published workspace',call(cp,`${proxy}/${app.id}/published`,cookie('1')),200);
await check('Foreign signed cookie app hidden',call(cp,`${proxy}/${app.id}`,cookie('2')),404);
const spoof=await check('Browser identity headers ignored',call(cp,`${proxy}/${app.id}`,{...cookie('2'),'x-hm-org-id':f['1'].orgId,'x-hm-user-id':f['1'].userId}),404);
function jwt(n,project=false,secret=f.runnerSecret){assert(secret,'Synthetic runner signing secret missing');const now=Math.floor(Date.now()/1000);const head=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const claims=Buffer.from(JSON.stringify({iss:'hivemind-harness-runner',aud:'hivemind-control-plane-harness-proxy',profile:'hivemind-chat',sub:f[n].userId,org_id:f[n].orgId,jti:crypto.randomUUID(),iat:now,exp:now+30,...(project?{project_id:f.projectId}:{})})).toString('base64url');const text=`${head}.${claims}`;return {Authorization:`Bearer ${text}.${crypto.createHmac('sha256',secret).update(text).digest('base64url')}`};}
const internal='/internal/v1/harness-chat/core'+prefix;
await check('Native runner JWT gateway',call(cp,`${internal}/${app.id}`,jwt('1')),200);
await check('Invalid runner signature',call(cp,internal,jwt('1',false,'invalid-synthetic-secret-at-least-32-characters')),401);
await check('Runner project scope denied',call(cp,internal,jwt('1',true)),403);
await check('Runner foreign app hidden',call(cp,`${internal}/${app.id}`,jwt('2')),404);
const sql=text=>execFileSync('ssh',['-o','BatchMode=yes','singulance-engine','docker exec -i crm-isolated-demo-20261006 psql -U crm_demo_admin -d crm_demo_full_auth -v ON_ERROR_STOP=1 -q'],{input:text,stdio:['pipe','pipe','pipe']}).toString();
try{sql(`UPDATE hivemind.user_organizations SET is_active=false WHERE user_id='${f['1'].userId}' AND org_id='${f['1'].orgId}';`);
 await check('Revoked member persisted key denied',call(core,`${prefix}/${app.id}`,key('1')),403);
 await check('Revoked member cookie denied',call(cp,`${proxy}/${app.id}`,cookie('1')),403);
 await check('Revoked member runner denied',call(cp,`${internal}/${app.id}`,jwt('1')),403);
}finally{sql(`UPDATE hivemind.user_organizations SET is_active=true WHERE user_id='${f['1'].userId}' AND org_id='${f['1'].orgId}';`);}
const concurrent=await Promise.all(['First','Second'].map((name,i)=>call(core,`${prefix}/${app.id}`,key('1'),'PATCH',{expectedVersion:1,spec:{...spec,name:`Draft ${name}`},operationId:`${run}-concurrent-${i}`})));assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);checks.push({name:'Concurrent draft patch admits one current revision',statuses:[200,409]});
const published=await check('Published list keeps immutable name',call(cp,proxy+'?published=true',cookie('1')),200);assert.equal(published.apps.find(a=>a.id===app.id).name,spec.name);
try{sql(`UPDATE hivemind.api_keys SET revoked_at=now() WHERE id='${f['1'].keyId}';`);await check('Revoked persisted API key denied',call(core,prefix,key('1')),401);}finally{sql(`UPDATE hivemind.api_keys SET revoked_at=NULL WHERE id='${f['1'].keyId}';`);}
const privileges=sql("SELECT has_any_column_privilege('hivemind_app_runtime','hivemind.users','UPDATE'),has_any_column_privilege('hivemind_app_runtime','hivemind.organizations','UPDATE'),has_any_column_privilege('hivemind_app_runtime','hivemind.user_organizations','UPDATE');");assert(privileges.includes('f')&&!privileges.includes('t'),'CRM role has identity mutation privileges');checks.push({name:'Provisioned role has no identity updates',status:'passed'});
await fs.writeFile('/tmp/hivemind-crm-authenticated-preview-20261006/report.json',JSON.stringify({source:'actual Core and Control Plane processes; native persisted keys, native signed Redis sessions, actual runner JWT verification; synthetic isolated full-schema Postgres',checks,appId:app.id,organizationId:f['1'].orgId,productionMutations:false},null,2));
console.log(JSON.stringify({passed:checks.length,report:'/tmp/hivemind-crm-authenticated-preview-20261006/report.json',appId:app.id}));

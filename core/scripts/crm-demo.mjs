/** Actual PostgreSQL + HTTP demo. Artificial identities only; never reads production env. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createAppRuntimeHandler } from '../src/app-runtime/routes.js';
import { createPostgresAppRuntimeTransactionRunner } from '../src/app-runtime/postgres-transaction.js';
import { EXAMPLE_CRM_SPEC } from '../src/app-runtime/contract.js';
import { assertAppRuntimePrincipal } from '../src/app-runtime/access.js';
import { forwardAppRuntimeRequest } from '../src/app-runtime/gateway.js';
import { verifyHarnessRunnerServiceToken } from '../src/harness-chat/runner-service-token.js';

const databaseUrl = process.env.CRM_DEMO_DATABASE_URL;
if (!databaseUrl) throw new Error('CRM_DEMO_DATABASE_URL must name a fresh isolated LOCAL demo database');
const parsed = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !/^\/crm_demo_[a-z0-9_]+$/.test(parsed.pathname)) {
  throw new Error('Refusing non-loopback or non-demo database');
}
const pg = process.env.CRM_DEMO_PG_MODULE
  ? (await import(pathToFileURL(process.env.CRM_DEMO_PG_MODULE))).default
  : (await import('pg')).default;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
let pool;
let server;
const checks = [];
const A = {orgId:'10000000-0000-4000-8000-000000000001',userId:'20000000-0000-4000-8000-000000000001'};
const B = {orgId:'10000000-0000-4000-8000-000000000002',userId:'20000000-0000-4000-8000-000000000002'};
try {
  const {rows:[{count}]} = await admin.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')");
  assert.equal(count, 0, 'Demo requires a fresh database; it never drops existing objects');
  await admin.query(`CREATE SCHEMA hivemind;
    CREATE TABLE hivemind.organizations(id uuid PRIMARY KEY);
    CREATE TABLE hivemind.users(id uuid PRIMARY KEY, deleted_at timestamptz);
    CREATE TABLE hivemind.user_organizations(org_id uuid NOT NULL REFERENCES hivemind.organizations(id), user_id uuid NOT NULL REFERENCES hivemind.users(id), role text NOT NULL, roles text[], is_active boolean NOT NULL, PRIMARY KEY(org_id,user_id));
    CREATE TABLE hivemind.hq_workflows(id uuid PRIMARY KEY,org_id uuid NOT NULL,title text,status text,graph_version integer,started_at timestamptz,completed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),context jsonb NOT NULL);`);
  await admin.query(await readFile(new URL('../prisma/migrations/20261005100000_app_runtime_infrastructure/migration.sql', import.meta.url), 'utf8'));
  checks.push('Actual App Runtime SQL migration applied to PostgreSQL');
  for (const actor of [A,B]) {
    await admin.query('INSERT INTO hivemind.organizations(id) VALUES($1)',[actor.orgId]);
    await admin.query('INSERT INTO hivemind.users(id) VALUES($1)',[actor.userId]);
    await admin.query("INSERT INTO hivemind.user_organizations(org_id,user_id,role,roles,is_active) VALUES($1,$2,'org_owner',ARRAY['org_owner'],true)",[actor.orgId,actor.userId]);
  }
  const role = `crm_demo_app_${Date.now()}`;
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'artificial-demo-only' NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA hivemind TO ${role};
    GRANT SELECT ON hivemind.users,hivemind.organizations,hivemind.user_organizations TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA hivemind TO ${role};
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA hivemind TO ${role};`);
  const appUrl = new URL(databaseUrl); appUrl.username=role; appUrl.password='artificial-demo-only';
  pool = new pg.Pool({connectionString:appUrl.toString(),max:4});
  const {rows:[principalFlags]}=await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  assert.equal(principalFlags.rolsuper,false); assert.equal(principalFlags.rolbypassrls,false);
  checks.push('Application pool is non-superuser and cannot bypass RLS');
  const fixtureSecret='crm-demo-artificial-runner-secret-32-characters-only';
  const fixtureMaster='artificial-crm-demo-master';
  const jsonResponse=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  const parseBody=async req=>{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>300*1024)throw new Error('Fixture request too large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');};
  const handle = createAppRuntimeHandler({transactionRunner:createPostgresAppRuntimeTransactionRunner(pool),resolvePrincipal:async req=>{
    const actor=req.headers.authorization===`Bearer ${fixtureMaster}`
      ? [A,B].find(candidate=>candidate.orgId===req.headers['x-hm-org-id']&&candidate.userId===req.headers['x-hm-user-id'])
      : ({a:A,b:B})[req.headers['x-crm-demo-actor']];
    return assertAppRuntimePrincipal({...actor,scopes:['app:write']},req.method);
  }});
  let origin;
  server=createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    const prefix='/internal/v1/harness-chat/core';
    if(pathname.startsWith(prefix)){
      let claims;
      try{claims=verifyHarnessRunnerServiceToken(String(req.headers.authorization||'').replace(/^Bearer /,''),{secret:fixtureSecret});}
      catch{jsonResponse(res,{error:{code:'unauthorized'}},401);return;}
      const {rows:[membership]}=await admin.query('SELECT is_active FROM hivemind.user_organizations WHERE org_id=$1 AND user_id=$2',[claims.org_id,claims.sub]);
      if(!membership?.is_active){jsonResponse(res,{error:{code:'forbidden'}},403);return;}
      if(await forwardAppRuntimeRequest({req,res,corePath:pathname.slice(prefix.length),claims,env:{HIVE_APP_RUNTIME_ENABLED:'true'},coreApiBaseUrl:origin,internalApiKey:fixtureMaster,parseBody,jsonResponse}))return;
    }
    if(!await handle({req,res,pathname})){res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
  async function request(actor,path='',method='GET',body,expected=200){
    const response=await fetch(`${origin}/api/app-runtime/apps${path}`,{method,headers:{'x-crm-demo-actor':actor,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;
  }
  const draftA={spec:EXAMPLE_CRM_SPEC,operationId:'demo-a-draft'};
  const {app:a}=await request('a','','POST',draftA);
  const replay=await request('a','','POST',draftA);assert.equal(replay.app.id,a.id);
  await request('a','','POST',{...draftA,spec:{...EXAMPLE_CRM_SPEC,name:'Conflict'}},409);
  const {app:b}=await request('b','','POST',{spec:{...EXAMPLE_CRM_SPEC,name:'Organization B CRM'},operationId:'demo-b-draft'});
  assert.notEqual(a.id,b.id); checks.push('Two artificial organizations have distinct applications; draft retry returns the same receipt');
  await request('b',`/${a.id}`,'GET',undefined,404);await request('a',`/${b.id}`,'GET',undefined,404);
  assert.equal((await request('a')).apps.length,1);assert.equal((await request('b')).apps.length,1);
  await request('a',`/${a.id}/validate`,'POST',{});
  await request('a',`/${a.id}/publish`,'POST',{expectedVersion:1,operationId:'demo-a-publish'});
  await request('b',`/${b.id}/publish`,'POST',{expectedVersion:1,operationId:'demo-b-publish'});
  checks.push('Validate/publish succeeds; tenant crossing is denied by HTTP service');
  const {record:company}=await request('a',`/${a.id}/records`,'POST',{entityId:'company',data:{name:'Artificial Acme',industry:'Demo'},operationId:'demo-a-company'});
  const {record:foreignCompany}=await request('b',`/${b.id}/records`,'POST',{entityId:'company',data:{name:'Artificial Beta'},operationId:'demo-b-company'});
  const dealInput={entityId:'deal',data:{name:'Artificial Review',company:company.id,amount:5000,stage:'Review'},operationId:'demo-a-deal'};
  const {record:deal}=await request('a',`/${a.id}/records`,'POST',dealInput);
  assert.equal((await request('a',`/${a.id}/records`,'POST',dealInput)).record.id,deal.id);
  await request('a',`/${a.id}/records`,'POST',{...dealInput,operationId:'demo-cross-reference',data:{...dealInput.data,company:foreignCompany.id}},400);
  await request('a',`/${a.id}/records/${deal.id}`,'PATCH',{expectedVersion:1,data:{stage:'Won'},operationId:'demo-a-deal-update'});
  await request('a',`/${a.id}/records/${deal.id}`,'PATCH',{expectedVersion:1,data:{stage:'Lost'},operationId:'demo-a-stale'},409);
  assert.equal((await request('a',`/${a.id}/records?entityId=deal`)).records[0].data.stage,'Won');
  checks.push('Record/reference writes persist; cross-tenant references and stale edits are denied; replay does not duplicate');
  await admin.query('UPDATE hivemind.user_organizations SET is_active=false WHERE org_id=$1 AND user_id=$2',[A.orgId,A.userId]);
  await request('a',`/${a.id}/records`,'POST',dealInput,403);
  await admin.query("UPDATE hivemind.user_organizations SET is_active=true,role='viewer',roles=ARRAY['viewer'] WHERE org_id=$1 AND user_id=$2",[A.orgId,A.userId]);
  await request('a',`/${a.id}`);
  await request('a',`/${a.id}/publish`,'POST',{expectedVersion:1,operationId:'demo-viewer-denied'},403);
  await admin.query("UPDATE hivemind.user_organizations SET role='member',roles=ARRAY['member'] WHERE org_id=$1 AND user_id=$2",[A.orgId,A.userId]);
  await request('a',`/${a.id}/records/${deal.id}`,'PATCH',{expectedVersion:2,data:{amount:6000},operationId:'demo-member-write'});
  await request('a',`/${a.id}/publish`,'POST',{expectedVersion:1,operationId:'demo-member-publish-denied'},403);
  await admin.query("UPDATE hivemind.user_organizations SET role='org_owner',roles=ARRAY['org_owner'] WHERE org_id=$1 AND user_id=$2",[A.orgId,A.userId]);
  checks.push('Revocation blocks receipt replay; viewer reads only; member writes records but cannot publish');
  const specV2=structuredClone(EXAMPLE_CRM_SPEC);specV2.entities[0].fields.push({id:'technical_fit',name:'Technical fit',type:'number'});
  await request('a',`/${a.id}`,'PATCH',{expectedVersion:1,spec:specV2,operationId:'demo-a-spec-v2'});
  assert.equal((await request('a',`/${a.id}/published`)).app.version,1);
  assert.equal((await request('a',`/${a.id}`)).app.version,2);
  await request('a',`/${a.id}/publish`,'POST',{expectedVersion:2,operationId:'demo-a-publish-v2'});
  assert.equal((await request('a',`/${a.id}/records?entityId=company`)).records[0].data.name,'Artificial Acme');
  const destructive=structuredClone(specV2);destructive.entities[0].fields=destructive.entities[0].fields.filter(field=>field.id!=='name');
  await request('a',`/${a.id}`,'PATCH',{expectedVersion:2,spec:destructive,operationId:'demo-destructive'},409);
  const concurrent=await Promise.all(['one','two'].map(async suffix=>{
    const response=await fetch(`${origin}/api/app-runtime/apps/${a.id}`,{method:'PATCH',headers:{'x-crm-demo-actor':'a','content-type':'application/json'},body:JSON.stringify({expectedVersion:2,spec:{...specV2,name:`Concurrent ${suffix}`},operationId:`demo-concurrent-${suffix}`})});
    await response.json();return response.status;
  }));
  assert.deepEqual(concurrent.sort(),[200,409]);
  assert.equal((await request('a','?published=true')).apps[0].version,2);
  assert.equal((await request('a','?published=true')).apps[0].name,'Enterprise CRM');
  checks.push('Concurrent expected-version edits admit exactly one winner; published listing stays on reviewed v2 while current draft is v3');
  checks.push('Compatible metadata version published without data loss; destructive schema mutation rejected');
  const client=await pool.connect();
  try{await client.query('BEGIN');await client.query("SELECT set_config('app.hivemind_org_id',$1,true)",[A.orgId]);
    const {rows}=await client.query('SELECT org_id FROM hivemind.app_runtime_apps');assert.equal(rows.length,1);assert.equal(rows[0].org_id,A.orgId);await client.query('ROLLBACK');
  }finally{client.release();}
  await assert.rejects(admin.query('UPDATE hivemind.app_runtime_versions SET spec=spec'),/append-only/);
  checks.push('Database RLS isolates organization rows; version history rejects mutation');
  await admin.query("INSERT INTO hivemind.hq_workflows(id,org_id,title,status,graph_version,started_at,completed_at,context) VALUES('30000000-0000-4000-8000-000000000001',$1,'Artificial receipt fixture — not an executed workflow','completed',1,now(),now(),$2::jsonb)",[A.orgId,JSON.stringify({app_runtime:{app_id:a.id}})]);
  assert.equal((await request('a',`/${a.id}/workflows`)).workflows.length,1);
  assert.equal((await request('b',`/${b.id}/workflows`)).workflows.length,0);
  await request('b',`/${a.id}/workflows`,'GET',undefined,404);
  checks.push('Persisted synthetic HQ workflow receipt links to the correct app/tenant; this is projection verification, not workflow execution');
  function runnerToken(actor=A,extra={},secret=fixtureSecret){
    const now=Math.floor(Date.now()/1000);
    const encoded=[{alg:'HS256',typ:'JWT'},{iss:'hivemind-harness-runner',aud:'hivemind-control-plane-harness-proxy',profile:'hivemind-chat',sub:actor.userId,org_id:actor.orgId,jti:randomUUID(),iat:now,exp:now+25,...extra}].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return `${encoded}.${createHmac('sha256',secret).update(encoded).digest('base64url')}`;
  }
  async function gateway(token,headers={}){const response=await fetch(`${origin}/internal/v1/harness-chat/core/api/app-runtime/apps`,{headers:{authorization:`Bearer ${token}`,...headers}});return{status:response.status,value:await response.json()};}
  const scoped=await gateway(runnerToken(A,{project_id:'40000000-0000-4000-8000-000000000001'}));assert.equal(scoped.status,403);
  assert.equal((await gateway(runnerToken(A,{},'wrong-artificial-secret-that-is-long-enough'))).status,401);
  const spoof=await gateway(runnerToken(),{'x-hm-org-id':B.orgId,'x-hm-user-id':B.userId});assert.equal(spoof.status,200);assert.equal(spoof.value.apps[0].id,a.id);
  checks.push('Native runner token verification + narrow gateway rejects wrong signatures/project scope and ignores spoofed tenant headers');
  const {rows:[receipts]}=await admin.query('SELECT (SELECT count(*)::int FROM hivemind.app_runtime_operations) AS operations,(SELECT count(*)::int FROM hivemind.app_runtime_audit) AS audit_events');
  const report={database:'PostgreSQL',serverVersion:(await admin.query('SHOW server_version')).rows[0].server_version,migration:'20261005100000_app_runtime_infrastructure',origin,checks,receipts,apps:{a:a.id,b:b.id},scope:'Artificial local fixtures; minimal identity table fixture; real CRM migration and service; no production authentication, UI, connector or workflow execution claim'};
  if(process.env.CRM_DEMO_REPORT)await writeFile(process.env.CRM_DEMO_REPORT,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(process.env.CRM_DEMO_SERVE==='1'){
    console.log('Serving artificial demo API until interrupted; x-crm-demo-actor: a or b.');
    await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  }
}finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  await pool?.end();await admin.end();
}

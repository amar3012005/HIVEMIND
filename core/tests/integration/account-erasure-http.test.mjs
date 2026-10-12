import test from 'node:test';
// Run ONLY against the isolated Linux image and a schema-only fictional fixture DB.
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {getCentralPrismaClient} from '../../src/db/prisma.js';
import {ControlPlaneSessionStore,getRedisClient} from '../../src/control-plane/session-store.js';
test('isolated authenticated account erasure HTTP lifecycle', {skip:!process.env.DATABASE_URL?.includes('account_erasure_full_20261012')}, async()=> {
if(!process.env.DATABASE_URL?.includes('account_erasure_full_20261012'))throw new Error('Dedicated erasure fixture database required');
for(const name of ['HIVEMIND_ADMIN_SECRET','HIVEMIND_CONTROL_PLANE_SESSION_SECRET','HIVEMIND_PLATFORM_ADMIN_PASSCODE','HIVEMIND_MASTER_API_KEY'])process.env[name]=crypto.randomBytes(32).toString('hex');
process.env.CONTROL_PLANE_PORT='3910';process.env.HIVEMIND_RUNTIME_ROLE='app';
process.env.HIVEMIND_CORE_API_BASE_URL='http://127.0.0.1:3911';process.env.HIVEMIND_CORE_API_PUBLIC_URL='http://127.0.0.1:3911';
process.env.QDRANT_URL='http://127.0.0.1:3911';process.env.KNOWLEDGE_INGEST_WORKFLOW_URL='http://127.0.0.1:3911';process.env.KNOWLEDGE_INGEST_WORKFLOW_SECRET=crypto.randomBytes(32).toString('hex');
let destructiveRequests=0;
const objects=new Set();
const mock=http.createServer((req,res)=>{
 if(req.url.startsWith('/objects/')) {
  if(req.headers.authorization!==`Bearer ${process.env.KNOWLEDGE_INGEST_WORKFLOW_SECRET}`){res.writeHead(403);res.end();return;}
  const key=decodeURIComponent(req.url.slice('/objects/'.length));
  if(req.method==='DELETE'){destructiveRequests++;objects.delete(key);res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');return;}
  res.writeHead(objects.has(key)?200:404);res.end();return;
 }
 if(req.url.startsWith('/collections/')&&['DELETE','POST'].includes(req.method))destructiveRequests++;
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',result:{status:'completed'}}));
});await new Promise(r=>mock.listen(3911,'127.0.0.1',r));
const db=getCentralPrismaClient();const userId=crypto.randomUUID();const orgId=crypto.randomUUID();const artifactId=crypto.randomUUID();const docId=crypto.randomUUID();
await db.user.create({data:{id:userId,zitadelUserId:`fixture-${userId}`,email:`${userId}@example.invalid`}});
await db.organization.create({data:{id:orgId,zitadelOrgId:`fixture-${orgId}`,name:'Fictional erasure HTTP fixture',slug:`fixture-${orgId}`}});
await db.userOrganization.create({data:{userId,orgId,role:'owner'}});
await db.$executeRawUnsafe('INSERT INTO hivemind.harness_dream_settings(org_id,user_id) VALUES($1::uuid,$2::uuid)',orgId,userId);
await db.$executeRawUnsafe('INSERT INTO hivemind.harness_dream_due(org_id,user_id) VALUES($1::uuid,$2::uuid)',orgId,userId);
const nativeSessionId=`erasure-fixture-${userId}`;
await db.$executeRawUnsafe("INSERT INTO hivemind.harness_sessions(id,org_id,user_id,profile,variation,header) VALUES($1,$2::uuid,$3::uuid,'hive','default','{}'::jsonb)",nativeSessionId,orgId,userId);
await db.$executeRawUnsafe('INSERT INTO hivemind.harness_company_hq(org_id,user_id,session_id) VALUES($1::uuid,$2::uuid,$3)',orgId,userId,nativeSessionId);
await db.$executeRawUnsafe("INSERT INTO hivemind.harness_scheduled_tasks(id,session_id,org_id,user_id,actor_user_id,record,scheduled_at) VALUES($1,$2,$3::uuid,$4::uuid,$4::uuid,'{}'::jsonb,now()+interval '1 day')",`erasure-schedule-${userId}`,nativeSessionId,orgId,userId);
await db.sourceArtifact.create({data:{id:artifactId,userId,orgId,artifactType:'upload',sourcePlatform:'knowledge_upload',checksum:'a'.repeat(64),storageLocation:`kb/${userId}/fixture`,metadata:{sourceObjectKey:`org/${orgId}/sha256/${'a'.repeat(64)}/fixture.txt`}}});
await db.knowledgeDocument.create({data:{id:docId,userId,orgId,sourceArtifactId:artifactId,documentType:'file',sourcePlatform:'knowledge_upload'}});
objects.add(`org/${orgId}/sha256/${'a'.repeat(64)}/fixture.txt`);
const store=new ControlPlaneSessionStore({redisUrl:process.env.REDIS_URL,sessionTtlSeconds:3600});const session=await store.createSession({userId,orgId});
const log=fs.openSync(process.env.ERASURE_FIXTURE_LOG || '/tmp/account-erasure-control-fixture.log','w');let child;
const boot=async()=>{child=spawn(process.execPath,['src/control-plane-server.js'],{env:process.env,stdio:['ignore',log,log]});for(let n=0;n<100;n++){try{await fetch('http://127.0.0.1:3910/v1/account/erasure');return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('Fixture control service failed to start');};
try {
 await boot();
 const response=await fetch('http://127.0.0.1:3910/v1/account/delete',{method:'POST',headers:{authorization:`Bearer ${session}`,'content-type':'application/json'},body:JSON.stringify({confirm:'DELETE'})});
 assert.equal(response.status,202);assert.equal(response.headers.get('set-cookie'),null);
 const admitted=await response.json();assert.ok(admitted.receiptToken);const url=`http://127.0.0.1:3910/v1/account/erasure?operationId=${admitted.operationId}`;
 const status=async token=>fetch(url,{headers:{authorization:`Erasure ${token}`}});
 assert.equal((await status(`${admitted.receiptToken.slice(0,-1)}!`)).status,401);
 assert.equal((await fetch(url.replace(admitted.operationId,crypto.randomUUID()),{headers:{authorization:`Erasure ${admitted.receiptToken}`}})).status,401);
 let final;
 for(let n=0;n<100;n++){const r=await status(admitted.receiptToken);final=await r.json();if(final.status==='completed'||final.status==='blocked')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(final.status,'completed',JSON.stringify(final));assert.equal(await db.user.findUnique({where:{id:userId}}),null);assert.equal(await db.knowledgeDocument.count({where:{userId}}),0);
 child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));await boot();
 assert.equal((await (await status(admitted.receiptToken)).json()).status,'completed');
 await db.$executeRawUnsafe("UPDATE hivemind.account_erasure_operations SET status_token_expires_at=now()-interval '1 second' WHERE id=$1::uuid",admitted.operationId);
 assert.equal((await status(admitted.receiptToken)).status,401);
 const blockedCase=async({shared=false,active=false})=>{
  const uid=crypto.randomUUID(),oid=crypto.randomUUID(),aid=crypto.randomUUID(),did=crypto.randomUUID();
  await db.user.create({data:{id:uid,zitadelUserId:`fixture-${uid}`,email:`${uid}@example.invalid`}});
  await db.organization.create({data:{id:oid,zitadelOrgId:`fixture-${oid}`,name:'Fictional blocked erasure fixture',slug:`fixture-${oid}`}});
  await db.userOrganization.create({data:{userId:uid,orgId:oid,role:'owner'}});
  if(shared){const other=crypto.randomUUID();await db.user.create({data:{id:other,zitadelUserId:`fixture-${other}`,email:`${other}@example.invalid`}});await db.userOrganization.create({data:{userId:other,orgId:oid,role:'member'}});}
  const key=`org/${oid}/sha256/${'b'.repeat(64)}/blocked.txt`;objects.add(key);
  await db.sourceArtifact.create({data:{id:aid,userId:uid,orgId:oid,artifactType:'upload',sourcePlatform:'knowledge_upload',checksum:'b'.repeat(64),storageLocation:`kb/${uid}/fixture`,metadata:{sourceObjectKey:key}}});
  await db.knowledgeDocument.create({data:{id:did,userId:uid,orgId:oid,sourceArtifactId:aid,documentType:'file',sourcePlatform:'knowledge_upload'}});
  if(active)await db.$executeRawUnsafe("INSERT INTO hivemind.account_ingestion_leases(user_id,lane,state,created_at) VALUES($1::uuid,'fixture-late-write','active',now()-interval '7 days')",uid);
  const sid=await store.createSession({userId:uid,orgId:oid});const before=destructiveRequests;
  const request=await fetch('http://127.0.0.1:3910/v1/account/delete',{method:'POST',headers:{authorization:`Bearer ${sid}`,'content-type':'application/json'},body:JSON.stringify({confirm:'DELETE'})});assert.equal(request.status,202);assert.equal(request.headers.get('set-cookie'),null);
  const admitted=await request.json();let result;
  for(let n=0;n<100;n++){result=await (await fetch(`http://127.0.0.1:3910/v1/account/erasure?operationId=${admitted.operationId}`,{headers:{authorization:`Erasure ${admitted.receiptToken}`}})).json();if(result.status==='blocked')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(result.status,'blocked');assert.equal(result.failureCode,shared?'SHARED_OWNER_TRANSFER_REQUIRED':'ERASURE_INGEST_DRAIN_REQUIRED');assert.equal(destructiveRequests,before);assert.ok(objects.has(key));assert.ok(await db.user.findUnique({where:{id:uid}}));assert.equal(await db.knowledgeDocument.count({where:{userId:uid}}),1);
  if(shared)assert.equal(await db.userOrganization.count({where:{orgId:oid,role:'owner'}}),1);
 };
 await blockedCase({shared:true});await blockedCase({active:true});
 console.log('ERASURE_HTTP_FIXTURE_PASS: authenticated202, no early logout, exclusive finalization, wrong token/operation/expiry refusal, restart status, shared-copy protection, unknown old-write blocker');
} finally {child?.kill('SIGTERM');mock.close();await db.$disconnect();const redis=await getRedisClient({redisUrl:process.env.REDIS_URL});await redis?.quit();fs.closeSync(log);}

});

// Run ONLY against the isolated Linux image and a schema-only fictional fixture DB.
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {getCentralPrismaClient} from '../../src/db/prisma.js';
import {ControlPlaneSessionStore} from '../../src/control-plane/session-store.js';
if(!process.env.DATABASE_URL?.includes('account_erasure_full_20261012'))throw new Error('Dedicated erasure fixture database required');
for(const name of ['HIVEMIND_ADMIN_SECRET','HIVEMIND_CONTROL_PLANE_SESSION_SECRET','HIVEMIND_PLATFORM_ADMIN_PASSCODE','HIVEMIND_MASTER_API_KEY'])process.env[name]=crypto.randomBytes(32).toString('hex');
process.env.CONTROL_PLANE_PORT='3910';process.env.HIVEMIND_RUNTIME_ROLE='control';
process.env.HIVEMIND_CORE_API_BASE_URL='http://127.0.0.1:3911';process.env.HIVEMIND_CORE_API_PUBLIC_URL='http://127.0.0.1:3911';
process.env.QDRANT_URL='http://127.0.0.1:3911';process.env.KNOWLEDGE_INGEST_WORKFLOW_URL='http://127.0.0.1:3911';process.env.KNOWLEDGE_INGEST_WORKFLOW_SECRET=crypto.randomBytes(32).toString('hex');
const mock=http.createServer((req,res)=>{res.writeHead(req.method==='HEAD'?404:200,{'content-type':'application/json'});res.end(JSON.stringify(req.url.startsWith('/objects/')?{ok:true}:{status:'ok',result:{status:'completed'}}));});await new Promise(r=>mock.listen(3911,'127.0.0.1',r));
const db=getCentralPrismaClient();const userId=crypto.randomUUID();const orgId=crypto.randomUUID();const artifactId=crypto.randomUUID();const docId=crypto.randomUUID();
await db.user.create({data:{id:userId,zitadelUserId:`fixture-${userId}`,email:`${userId}@example.invalid`}});
await db.organization.create({data:{id:orgId,zitadelOrgId:`fixture-${orgId}`,name:'Fictional erasure HTTP fixture',slug:`fixture-${orgId}`}});
await db.userOrganization.create({data:{userId,orgId,role:'owner'}});
await db.sourceArtifact.create({data:{id:artifactId,userId,orgId,artifactType:'upload',sourcePlatform:'knowledge_upload',checksum:'a'.repeat(64),storageLocation:`kb/${userId}/fixture`,metadata:{sourceObjectKey:`org/${orgId}/sha256/${'a'.repeat(64)}/fixture.txt`}}});
await db.knowledgeDocument.create({data:{id:docId,userId,orgId,sourceArtifactId:artifactId,documentType:'file',sourcePlatform:'knowledge_upload'}});
const store=new ControlPlaneSessionStore({redisUrl:process.env.REDIS_URL,sessionTtlSeconds:3600});const session=await store.createSession({userId,orgId});
const log=fs.openSync('/tmp/account-erasure-control-fixture.log','w');let child;
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
 console.log('ERASURE_HTTP_FIXTURE_PASS: authenticated202, no early logout, exclusive finalization, wrong token/operation/expiry refusal, restart status');
} finally {child?.kill('SIGTERM');mock.close();await db.$disconnect();fs.closeSync(log);}

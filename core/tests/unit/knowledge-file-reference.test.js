import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { knowledgeFileReference, readOwnedKnowledgeFile } from '../../src/storage/knowledge-file-reference.js';
import { handleKnowledgeFileRoute } from '../../src/routes/knowledge-file.js';
const orgId='11111111-1111-4111-8111-111111111111', userId='22222222-2222-4222-8222-222222222222';
const bytes=Buffer.from('a real source document');
const job={ id:'33333333-3333-4333-8333-333333333333', orgId,userId,filename:'original.txt',contentType:'text/plain',
 checksum:createHash('sha256').update(bytes).digest('hex'),scopeType:'personal',scopeId:userId,scopeKey:`personal:${userId}` };
function deps(row=job) { return { principal:{orgId,userId,scopes:['memory.read']},jobId:job.id, jobStore:{findOwned:async(id,principal)=>{
 assert.equal(id,job.id);assert.deepEqual(principal,{orgId,userId});return row;
}}, prisma:{userOrganization:{findFirst:async()=>({role:'member',roles:[]})}},localQueue:{rawFilePath:()=>'/owned/source'},readLocal:async()=>bytes }; }
test('portable reference retains original identity without storage paths or credentials',()=>{
 const ref=knowledgeFileReference(job);assert.equal(ref.native_id,job.id);assert.equal(ref.id,`hive-file://${orgId}/brain/${job.id}`);
 assert.equal(JSON.stringify(ref).includes('/owned/'),false);assert.equal(ref.sha256,job.checksum);
});
test('local backend returns exact bytes from native owned storage',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'hive-file-'));
 try { const file=path.join(dir,'source');await writeFile(file,bytes);const d=deps();delete d.readLocal;d.localQueue.rawFilePath=()=>file;
 assert.deepEqual((await readOwnedKnowledgeFile(d)).bytes,bytes); } finally {await rm(dir,{recursive:true,force:true});}
});
test('foreign organization or user is rejected before any byte read',async()=>{
 for(const row of [{...job,orgId:userId},{...job,userId:orgId},null]) {const d=deps(row);d.readLocal=()=>assert.fail('must not read');await assert.rejects(readOwnedKnowledgeFile(d),{code:'file_not_found'});}
});
test('revoked membership rejects a persisted file',async()=>{
 const d=deps();d.prisma.userOrganization.findFirst=async()=>null;d.readLocal=()=>assert.fail('must not read');
 await assert.rejects(readOwnedKnowledgeFile(d),{code:'file_not_found'});
});
test('remote storage policy never falls back to a central copy',async()=>{
 const d=deps();d.isRemoteOrg=async()=>true;d.readLocal=()=>assert.fail('must not read');await assert.rejects(readOwnedKnowledgeFile(d),{code:'file_requires_selected_remote_store'});
});
test('object identity and checksum are independently verified',async()=>{
 const key=`org/${orgId}/sha256/${job.checksum}/original.txt`;
 const d=deps({...job,sourceObjectKey:key,sourceObjectEtag:'etag'});d.cloudflareQueue={getObject:async(k,o)=>{assert.equal(k,key);assert.equal(o.expectedEtag,'etag');return bytes;}};
 assert.deepEqual((await readOwnedKnowledgeFile(d)).bytes,bytes);
 const wrong=deps({...job,sourceObjectKey:key.replace(orgId,userId)});wrong.cloudflareQueue={getObject:()=>assert.fail('must not read')};
 await assert.rejects(readOwnedKnowledgeFile(wrong),{code:'file_storage_identity_mismatch'});
 d.cloudflareQueue.getObject=async()=>Buffer.from('corrupted');await assert.rejects(readOwnedKnowledgeFile(d),{code:'file_integrity_failed'});
});
test('a missing original has an explicit unavailable result, not reconstructed content',async()=>{
 const d=deps();d.localQueue.rawFilePath=()=>null;await assert.rejects(readOwnedKnowledgeFile(d),{code:'original_file_unavailable'});
});
test('HTTP output is a private attachment and never active content on application origin',async()=>{
 const d=deps({...job,filename:'example.html',contentType:'text/html'}),headers={};let output;
 const res={setHeader:(k,v)=>headers[k]=v,end:b=>output=b};
 await handleKnowledgeFileRoute({...d,req:{method:'GET'},res,url:new URL(`https://example.test/api/knowledge/file?job_id=${job.id}`),jsonResponse:()=>assert.fail('unexpected error')});
 assert.equal(res.statusCode,200);assert.equal(headers['Cache-Control'],'private, no-store');assert.equal(headers['Content-Type'],'application/octet-stream');assert.match(headers['Content-Disposition'],/^attachment;/);assert.deepEqual(output,bytes);
});

test('removed project access denies the original even for its uploader',async()=>{
 const d=deps({...job,scopeType:'project',scopeId:orgId,scopeKey:`project:${orgId}`});
 d.prisma.project={findMany:async()=>[]};d.readLocal=()=>assert.fail('must not read');
 await assert.rejects(readOwnedKnowledgeFile(d),{code:'file_not_found'});
});
test('storage outage cannot trigger an unverified local fallback',async()=>{
 const key=`org/${orgId}/sha256/${job.checksum}/original.txt`;
 const d=deps({...job,sourceObjectKey:key});d.readLocal=()=>assert.fail('must not read');
 d.cloudflareQueue={getObject:async()=>{throw new Error('upstream details that must stay private');}};
 let result;
 await handleKnowledgeFileRoute({...d,req:{method:'GET'},res:{},url:new URL(`https://example.test?job_id=${job.id}`),jsonResponse:(_r,body,status)=>result={body,status}});
 assert.deepEqual(result,{body:{error:'file_store_unavailable'},status:503});
});

test('delegated project, team, container and service keys cannot inherit private source access',async()=>{
 for(const limits of [{scopes:[]},{projectId:orgId},{teamId:orgId},{containerTags:['restricted']},{isServiceKey:true}]) {
  const d=deps();Object.assign(d.principal,limits);d.readLocal=()=>assert.fail('must not read');
  await assert.rejects(readOwnedKnowledgeFile(d),{code:'file_not_found'});
 }
});

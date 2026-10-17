import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {retainConfiguredKnowledgeOriginal} from '../../src/storage/knowledge-originals.js';
const bytes=Buffer.from('retained original');
const input={orgId:'11111111-1111-4111-8111-111111111111',filename:'source.txt',checksum:createHash('sha256').update(bytes).digest('hex'),fileBuffer:bytes,storageMode:'hybrid',isRemoteOrg:async()=>false};
function client(){return {configured:()=>true,persistFile:async({orgId,checksum,filename})=>({objectKey:`org/${orgId}/sha256/${checksum}/${filename}`,etag:'verified'})};}
test('canonical receipt is usable for both admission and failed-job replay',async()=>{
 const result=await retainConfiguredKnowledgeOriginal({...input,objectClient:client()});
 assert.equal(result.sourceObjectKey,`org/${input.orgId}/sha256/${input.checksum}/source.txt`);assert.equal(result.sourceObjectEtag,'verified');
});
test('selected embedded and remote policies never add a central archive',async()=>{
 for(const change of [{storageMode:'amr_embedded'},{storageMode:'byod_amr'},{isRemoteOrg:async()=>true}]) {
  assert.equal(await retainConfiguredKnowledgeOriginal({...input,...change,objectClient:{configured:()=>true,persistFile:()=>assert.fail('must not write')}}),null);
 }
});
test('corrupted retry bytes cannot be published under the original checksum',async()=>{
 await assert.rejects(retainConfiguredKnowledgeOriginal({...input,fileBuffer:Buffer.from('changed'),objectClient:client()}),{code:'SOURCE_OBJECT_INTEGRITY_FAILED'});
});
test('a foreign receipt cannot replace the owned object coordinates',async()=>{
 await assert.rejects(retainConfiguredKnowledgeOriginal({...input,objectClient:{configured:()=>true,persistFile:async()=>({objectKey:'org/other/source'})}}),{code:'SOURCE_OBJECT_STORE_FAILED'});
});
test('an unavailable configured archive leaves dispatch to fail rather than claim retention',async()=>{
 await assert.rejects(retainConfiguredKnowledgeOriginal({...input,objectClient:{configured:()=>true,persistFile:async()=>{throw Error('offline');}}}),/offline/);
});

test('native Worker receipt retains decoded spaces and Unicode filenames',async()=>{
 const name='会社 source.txt';const objectKey=`org/${input.orgId}/sha256/${input.checksum}/${name}`;
 const receipt=await retainConfiguredKnowledgeOriginal({...input,filename:name,objectClient:{configured:()=>true,persistFile:async()=>({objectKey})}});
 assert.equal(receipt.sourceObjectKey,objectKey);
});

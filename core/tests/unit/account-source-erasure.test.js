import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareKnowledgeIngestClient } from '../../src/knowledge/cloudflare-ingest-client.js';
const client = responses => { const calls=[]; const instance=new CloudflareKnowledgeIngestClient(); instance._request=async (path,init)=>{calls.push([path,init.method]); return responses.shift();}; return {instance,calls}; };
test('durable source deletion verifies absence and repeats idempotently',async()=>{
 const {instance,calls}=client([{ok:true,status:200},{status:404},{ok:false,status:404},{status:404}]);
 assert.deepEqual(await instance.deleteObjectVerified('org/user/key'),{status:'erased',verifiedAbsent:true});
 await instance.deleteObjectVerified('org/user/key'); assert.deepEqual(calls.map(c=>c[1]),['DELETE','HEAD','DELETE','HEAD']); assert.equal(calls[0][0],'/objects/org%2Fuser%2Fkey');
});
test('denied deletion cannot produce a receipt',async()=>{
 const {instance,calls}=client([{ok:false,status:403}]); await assert.rejects(instance.deleteObjectVerified('key'),{code:'SOURCE_ERASURE_AUTHORIZATION_REQUIRED',retryable:false}); assert.equal(calls.length,1);
});
test('surviving object and verification outage block identity deletion',async()=>{
 for(const status of [200,503]){const {instance}=client([{ok:true,status:200},{status}]);await assert.rejects(instance.deleteObjectVerified('key'),{code:'SOURCE_OBJECT_ERASURE_UNVERIFIED',retryable:status===503});}
});

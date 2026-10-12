import test from 'node:test';import assert from 'node:assert/strict';
import {reconcileOwnedSourceObjects,inventoryAccountErasureSources} from '../../src/security/account-erasure-sources.js';
test('unverified drain and missing remote authorization prevent object erasure',async()=>{
 for(const input of [{inventory:{remote:[],coordinates:[]}}, {inventory:{remote:[{}],coordinates:[]},drainReceipt:{verified:true,noLateExternalWrites:true}}]) await assert.rejects(reconcileOwnedSourceObjects(input));
});
test('shared bytes are retained and owned copies require verified erasure before receipt',async()=>{
 const receipts=[];let deletes=0;
 await reconcileOwnedSourceObjects({inventory:{remote:[],coordinates:[{key:'shared',shared:true,foreignReferences:2},{key:'owned',shared:false}]},drainReceipt:{verified:true,noLateExternalWrites:true},objectClient:{configured:()=>true,deleteObjectVerified:async()=>{deletes++;return{verifiedAbsent:true};}},saveReceipt:async receipt=>receipts.push(receipt)});
 assert.equal(deletes,1);assert.deepEqual(receipts.map(r=>r.outcome),['retained_shared','erased']);
});

test('metadata cannot turn an owned artifact into permission to delete a foreign org object',async()=>{const artifact={id:'source',userId:'self',orgId:'owned-org',checksum:'a'.repeat(64),storageLocation:'kb/self/record',metadata:{sourceObjectKey:`org/foreign-org/sha256/${'a'.repeat(64)}/secret.txt`},documents:[]};const db=Object.fromEntries(['knowledgeIngestJob','knowledgeDocument','sourceArtifact'].map(name=>[name,{findMany:async()=>name==='sourceArtifact'?[artifact]:[],count:async()=>0}]));const inventory=await inventoryAccountErasureSources(db,{userId:'self',ownershipSnapshot:{organizations:[]}});assert.deepEqual(inventory.invalidCoordinates,['source']);await assert.rejects(reconcileOwnedSourceObjects({inventory,drainReceipt:{verified:true,noLateExternalWrites:true}}),{code:'SOURCE_ERASURE_SCOPE_UNVERIFIED'});});

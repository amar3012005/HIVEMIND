import test from 'node:test';import assert from 'node:assert/strict';
import {reconcileOwnedSourceObjects} from '../../src/security/account-erasure-sources.js';
test('unverified drain and missing remote authorization prevent object erasure',async()=>{
 for(const input of [{inventory:{remote:[],coordinates:[]}}, {inventory:{remote:[{}],coordinates:[]},drainReceipt:{verified:true,noLateExternalWrites:true}}]) await assert.rejects(reconcileOwnedSourceObjects(input));
});
test('shared bytes are retained and owned copies require verified erasure before receipt',async()=>{
 const receipts=[];let deletes=0;
 await reconcileOwnedSourceObjects({inventory:{remote:[],coordinates:[{key:'shared',shared:true,foreignReferences:2},{key:'owned',shared:false}]},drainReceipt:{verified:true,noLateExternalWrites:true},objectClient:{configured:()=>true,deleteObjectVerified:async()=>{deletes++;return{verifiedAbsent:true};}},saveReceipt:async receipt=>receipts.push(receipt)});
 assert.equal(deletes,1);assert.deepEqual(receipts.map(r=>r.outcome),['retained_shared','erased']);
});

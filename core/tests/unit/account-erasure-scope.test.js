import test from 'node:test';import assert from 'node:assert/strict';
import {planAccountErasureScope,inspectSourceObjectRetention} from '../../src/security/account-erasure-scope.js';
test('ownership plan is pure and retains shared company and connector originals',async()=>{
 let calls=0;const db={userOrganization:{findMany:async()=>++calls===1?[{orgId:'company',role:'owner'}]:[{userId:'other',role:'member'}]}};
 const scope=await planAccountErasureScope(db,'self');assert.equal(scope.organizations[0].disposition,'retain_shared');assert.equal(scope.connectorOriginals,'retain');
});
test('foreign source key references prevent physical deletion',async()=>{
 let query;const result=await inspectSourceObjectRetention({knowledgeIngestJob:{count:async q=>{query=q;return 2;}}},{userId:'self',sourceObjectKey:'key'});assert.equal(result.disposition,'retained_shared');assert.deepEqual(query.where,{sourceObjectKey:'key',userId:{not:'self'}});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readRuntimeAppearance, saveRuntimeAppearance, validateRuntimeAppearance } from '../../src/employees/runtime-appearance.js';
const principal={userId:'user-a',orgId:'00000000-0000-4000-8000-000000000001'};
const look=character=>({version:1,provider:'runtime-character',character,asset_version:'1'});
function database(role='admin') {
 const org={companyProfile:{companyName:'Acme',untouched:{value:42}}}; let active=true;
 const db={userOrganization:{findUnique:async query=>{assert.deepEqual(query.where.userId_orgId,principal);return {role,isActive:active};}}, organization:{findUnique:async query=>{assert.equal(query.where.id,principal.orgId);return org;}},$queryRawUnsafe:async(_sql,key)=>assert.equal(key,`runtime-appearance:${principal.orgId}`),$executeRawUnsafe:async(sql,json,id)=>{assert.match(sql,/jsonb_set/);assert.equal(id,principal.orgId);org.companyProfile.runtimeAppearance=JSON.parse(json);}};
 db.$transaction=async callback=>callback(db); return {db,org,deactivate:()=>{active=false;}};
}
test('default and six strict Runtime-only choices',()=>{
 for(const name of ['capsule','pebble','prism','orbit','spark','fold']) assert.equal(validateRuntimeAppearance(look(name)).character,name);
 for(const value of [null,[],{},look('https://bad.test'),{...look('orbit'),employee_id:'other'},{...look('orbit'),asset_version:'2'}]) assert.throws(()=>validateRuntimeAppearance(value),{status:400});
});
test('workspace save survives read, increments revision, preserves unrelated fields',async()=>{
 const {db,org}=database();assert.equal((await readRuntimeAppearance(db,principal)).appearance.character,'orbit');
 const result=await saveRuntimeAppearance(db,principal,{expected_revision:0,appearance:look('fold')});assert.equal(result.revision,1);
 assert.equal((await readRuntimeAppearance(db,principal)).appearance.character,'fold');assert.deepEqual(org.companyProfile.untouched,{value:42});assert.equal(org.companyProfile.companyName,'Acme');
 await assert.rejects(saveRuntimeAppearance(db,principal,{expected_revision:0,appearance:look('spark')}),{status:409});assert.equal(org.companyProfile.runtimeAppearance.appearance.character,'fold');
});
test('members read but cannot save; inactive membership cannot read',async()=>{
 const {db,deactivate}=database('member');assert.equal((await readRuntimeAppearance(db,principal)).can_edit,false);
 await assert.rejects(saveRuntimeAppearance(db,principal,{expected_revision:0,appearance:look('capsule')}),{status:403});deactivate();await assert.rejects(readRuntimeAppearance(db,principal),{status:403});
});
test('rejects employee targets and malformed save bodies',async()=>{
 const {db}=database();for(const input of [1,[],null,{employee_id:'runtime',expected_revision:0,appearance:look('fold')},{expected_revision:-1,appearance:look('fold')}]) await assert.rejects(saveRuntimeAppearance(db,principal,input),{status:400});
});
test('invalid old metadata falls back without accepting external assets',async()=>{
 const {db,org}=database();org.companyProfile.runtimeAppearance={revision:2,appearance:{url:'https://outside.test'}};
 assert.equal((await readRuntimeAppearance(db,principal)).appearance.character,'orbit');
});

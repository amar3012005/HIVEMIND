import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileStore } from '../../src/memory/profile-store.js';
const orgs={a:[{key:'company.name',value:'Shared Company'},{key:'company.mission',value:'Shared mission'}],b:[]};
const db={userProfile:{findMany:async({where})=>where.userId==='owner'?[{key:'name',value:'Owner',category:'static',confidence:1}]:[]},user:{findUnique:async({where})=>({displayName:where.id==='invitee'?'Invited Google Name':'Provider Owner',locale:'en',deletedAt:null})},organizationProfile:{findMany:async({where})=>orgs[where.orgId]||[]}};
test('invited identity and shared organization appear together without owner identity',async()=>{
const store=new ProfileStore(db);const context=await store.buildCompactProfileContext('invitee','a');
assert.match(context,/Invited Google Name/);assert.match(context,/Shared Company/);assert.doesNotMatch(context,/Owner/);
});
test('explicit personal name wins over sign-in fallback',async()=>{
const context=await new ProfileStore(db).buildCompactProfileContext('owner','a');assert.match(context,/- name: Owner/);assert.doesNotMatch(context,/Provider Owner/);
});
test('another organization never receives shared company facts and packet remains bounded',async()=>{
const store=new ProfileStore(db);assert.doesNotMatch(await store.buildCompactProfileContext('invitee','b'),/Shared Company/);
assert.ok((await store.buildCompactProfileContext('invitee','a',null,{maxChars:250})).length<=250);
});
import {saveCompanyProfileFacts} from '../../src/identity/company-profile.js';
test('company setup writes organization keys and rejects personal facts',async()=>{
const writes=[];const tx={organizationProfile:{upsert:async args=>writes.push(args),updateMany:async()=>{}}};const p={$transaction:async f=>f(tx)};
await saveCompanyProfileFacts(p,{orgId:'a',userId:'owner',facts:[{key:'company',value:'Shared Company'},{key:'company:mission',value:'Shared mission'}]});
assert.deepEqual(writes.map(w=>w.create.key),['company.name','company.mission']);assert.ok(writes.every(w=>w.create.orgId==='a'));
await assert.rejects(saveCompanyProfileFacts(p,{orgId:'a',userId:'owner',facts:[{key:'name',value:'Private person'}]}),/Not a company fact/);
});

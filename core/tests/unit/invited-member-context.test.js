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
test('the organization detail is opt-in, uses the newest version of each fact, has its own budget and stays in its organization',async()=>{
const rich={a:[{key:'company.name',value:'Shared Company',version:1},{key:'company.offer',value:'Old offer',version:1},{key:'company.offer',value:'AI employees for companies',version:2},
{key:'company.icp',value:'B2B founders in Europe',version:1},{key:'company.positioning',value:'A team, not a single agent',version:1},{key:'company.operating_context',value:'x'.repeat(1600),version:1}]};
const store=new ProfileStore({...db,organizationProfile:{findMany:async({where})=>rich[where.orgId]||[]}});
const compact=await store.buildCompactProfileContext('invitee','a');assert.doesNotMatch(compact,/organization offer/,'default packet unchanged');
const full=await store.buildCompactProfileContext('invitee','a',null,{organizationDetail:true});
assert.match(full,/- organization offer: AI employees for companies/);assert.doesNotMatch(full,/Old offer/);
assert.match(full,/- organization icp: B2B founders in Europe/);assert.match(full,/- organization positioning: A team, not a single agent/);
assert.ok(/- organization operating_context: x{700}$/m.test(full),'long facts are clipped');
assert.ok(full.length<=900+2400+40,'bounded');
assert.doesNotMatch(await store.buildCompactProfileContext('invitee','b',null,{organizationDetail:true}),/organization offer/,'no other organization');
});

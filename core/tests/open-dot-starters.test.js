import test from 'node:test';
import assert from 'node:assert/strict';
import {provisionOpenDotStarter, starterCreationKey} from '../src/onboarding/open-dot-starters.js';
import {createOpenDotEmployee} from '../src/employees/open-dot-registry.js';

const principal={orgId:'33333333-3333-4333-8333-333333333333',userId:'22222222-2222-4222-8222-222222222222'};
function fixture(){
 const rows=[]; const phases=[];
 const tx={$queryRawUnsafe:async()=>[],digitalEmployee:{
  findUnique:async({where})=>rows.find(r=>r.slug===where.orgId_slug.slug),
  findFirst:async({where})=>typeof where.id==='string'?rows.find(r=>r.id===where.id&&r.orgId===where.orgId):null,
  create:async({data})=>{const row={...data,archivedAt:null};rows.push(row);return row;},
  update:async({where,data})=>Object.assign(rows.find(r=>r.id===where.id),data),
 }};
 const db={userOrganization:{findUnique:async()=>({isActive:true,role:'admin'})},$transaction:async f=>f(tx)};
 const fetchImpl=async(url,options)=>{
  const id=url.endsWith('/materialize')?JSON.parse(options.body).employee_id:url.split('/').at(-2);
  const row=rows.find(r=>r.id===id);assert.ok(row);
  if(url.endsWith('/materialize'))phases.push(row.policyRules.native_lifecycle.phase);
  return new Response(JSON.stringify({organizationId:principal.orgId,userId:principal.userId,employeeId:id,
   creationKey:row.policyRules.open_dot_employee.creation_key,dotId:`dot-${id}`}));
 };
 return {db,rows,phases,fetchImpl};
}
test('predefined team uses saved canonical profiles, binds before ready, and retries without duplicates',async()=>{
 const f=fixture();
 for(const [slot,name] of ['Faraday','Feynmann','Turing'].entries()){
  const input={operation:'create',creation_key:starterCreationKey('https://example.com',slot),name,role:'Analyst',persona:`${name} company specialist`};
  const first=await provisionOpenDotStarter(f.db,principal,input,{slot,sessionCookie:'fixture',fetchImpl:f.fetchImpl});
  assert.equal(first.policyRules.native_lifecycle.profile_stage,'ready');
  assert.equal(first.policyRules.native_lifecycle.onboarding_required,false);
  assert.equal(first.policyRules.open_dot_employee.state,'bound');
  const replay=await provisionOpenDotStarter(f.db,principal,input,{slot,sessionCookie:'fixture',fetchImpl:f.fetchImpl});
  assert.equal(replay.id,first.id);assert.equal(replay.persona,input.persona);
 }
 assert.equal(f.rows.length,3);assert.deepEqual(f.phases.slice(0,4),['provisioning','active','active','active']);
});
test('public creation cannot claim a predefined role is approved',async()=>{
 const f=fixture(); const input={operation:'create',creation_key:'custom',name:'Custom',persona:'A proposed role'};
 await assert.rejects(createOpenDotEmployee(f.db,principal,{...input,predefinedStarter:{slot:0}}),/invalid_open_dot_employee_request/);
 const result=await createOpenDotEmployee(f.db,principal,input);
 assert.equal(result.employee.policyRules.native_lifecycle.onboarding_required,true);
});
test('interrupted materialization resumes the same employee and never grants scope',async()=>{
 const f=fixture();const input={operation:'create',creation_key:starterCreationKey('https://example.org',0),name:'Faraday',role:'Analyst',persona:'Fixed profile'};
 await assert.rejects(provisionOpenDotStarter(f.db,principal,input,{slot:0,sessionCookie:'fixture',fetchImpl:async()=>new Response('',{status:503})}),/materialization_pending/);
 assert.equal(f.rows.length,1);assert.equal(f.rows[0].policyRules.native_lifecycle.phase,'provisioning');
 const recovered=await provisionOpenDotStarter(f.db,principal,input,{slot:0,sessionCookie:'fixture',fetchImpl:f.fetchImpl});
 assert.equal(f.rows.length,1);assert.deepEqual(f.rows[0].tools,[]);assert.deepEqual(f.rows[0].enabledConnectors,[]);
 assert.equal(recovered.policyRules.native_lifecycle.phase,'active');
 await assert.rejects(provisionOpenDotStarter(f.db,principal,{...input,persona:'Changed role'},{slot:0,sessionCookie:'fixture',fetchImpl:f.fetchImpl}),/creation_key_content_conflict/);
});

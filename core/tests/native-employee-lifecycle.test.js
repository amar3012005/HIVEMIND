import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNativeCreation, employeeCanDispatch, requireLifecycleAdministrator, manageNativeEmployee } from '../src/employees/native-lifecycle.js';
const base = { operation:'create', creation_key:'specialist-1', name:'Researcher', persona:'Read evidence and report', lifecycle:'durable' };
test('creation has a bounded native contract', () => {
  assert.equal(validateNativeCreation(base, 0).lifecycle, 'durable');
  assert.throws(() => validateNativeCreation({...base, tools:['slack:act']},0), /invalid_employee_creation/);
  assert.throws(() => validateNativeCreation({...base,lifecycle:'temporary'},0), /future_deadline_required/);
  assert.throws(() => validateNativeCreation({...base,avatar_url:'http://example.com/a.png'},0), /invalid_avatar_url/);
});
test('closed, expired and archived employees cannot dispatch business work', () => {
  const employee = { status:'draft', policyRules:{native_lifecycle:{version:1,phase:'active',kind:'temporary',expires_at:'2026-10-06T10:00:00Z'}} };
  assert.equal(employeeCanDispatch(employee,Date.parse('2026-10-06T09:00:00Z')),true);
  assert.equal(employeeCanDispatch(employee,Date.parse('2026-10-06T10:00:00Z')),false);
  assert.equal(employeeCanDispatch({...employee,archivedAt:new Date()},0),false);
  assert.equal(employeeCanDispatch({...employee,policyRules:{native_lifecycle:{version:1,phase:'closing'}}},0),false);
});
test('only a current active administrator may change the registry', async () => {
  for (const membership of [null,{isActive:false,role:'owner'},{isActive:true,role:'member'}]) {
    await assert.rejects(requireLifecycleAdministrator({userOrganization:{findUnique:async()=>membership}},{orgId:'a',userId:'b'}), /administrator_membership_required/);
  }
});

test('confirmed fresh archive retires only the requesting user\'s non-starter employee after private work is gone', async () => {
  const principal={orgId:'org',userId:'admin'};
  const row={id:'11111111-1111-4111-8111-111111111111',slug:'employee-owned',createdBy:'admin',status:'ready',
    policyRules:{native_lifecycle:{version:1,revision:2,phase:'active',kind:'durable'}}};
  let surviving=[];let foreignMemory=0;
  const tx={$queryRawUnsafe:async sql=>sql.includes('information_schema') ? [{table_schema:'hivemind'}]
    : sql.includes('harness_session_events') ? surviving : [],
    digitalEmployee:{findFirst:async()=>row,update:async({data})=>Object.assign(row,data)},
    hyperAgentOperatingMemory:{count:async()=>foreignMemory}};
  const db={userOrganization:{findUnique:async()=>({isActive:true,role:'admin'})},$transaction:async fn=>fn(tx)};
  const input={operation:'fresh_reset_archive',employee_id:row.id,expected_revision:2,confirmed:true};
  await assert.rejects(manageNativeEmployee(db,principal,{...input,confirmed:false}),/fresh_archive_not_authorized/);
  surviving=[{one:1}];
  await assert.rejects(manageNativeEmployee(db,principal,input),/fresh_archive_surviving_work/);
  surviving=[];foreignMemory=1;
  await assert.rejects(manageNativeEmployee(db,principal,input),/fresh_archive_shared_memory/);
  foreignMemory=0;
  const result=await manageNativeEmployee(db,principal,input,{now:Date.parse('2026-10-21T00:00:00Z')});
  assert.equal(result.freshReset,true);assert.ok(result.employee.archivedAt);
  assert.equal(result.employee.policyRules.native_lifecycle.phase,'archived');
  assert.equal((await manageNativeEmployee(db,principal,input)).replayed,true);
});

test('fresh archive ignores references only inside the storage user\'s own reset sessions', async () => {
  const principal={orgId:'org',userId:'human',sharedOrganizationAgents:true};
  const row={id:'11111111-1111-4111-8111-111111111111',slug:'employee-owned',createdBy:'human',status:'ready',
    policyRules:{native_lifecycle:{version:1,revision:2,phase:'active',kind:'durable'}}};
  let referencesCall;
  const tx={$queryRawUnsafe:async (sql,...args)=>{
    if(sql.includes('information_schema')) return [{table_schema:'hivemind'}];
    if(sql.includes('organization_agent_storage_scope')) return [{storage_user_id:'22222222-2222-4222-8222-222222222222',runtime_session_id:null}];
    if(sql.includes('harness_session_events')) { referencesCall={sql,args}; return []; }
    return [];},
    digitalEmployee:{findFirst:async()=>row,update:async({data})=>Object.assign(row,data)},
    hyperAgentOperatingMemory:{count:async()=>0}};
  const db={userOrganization:{findUnique:async()=>({isActive:true,role:'admin'})},$transaction:async fn=>fn(tx),};
  const input={operation:'fresh_reset_archive',employee_id:row.id,expected_revision:2,confirmed:true,reset_session_ids:['session-a','session-b']};
  await manageNativeEmployee(db,principal,input,{now:Date.parse('2026-10-21T00:00:00Z')});
  assert.match(referencesCall.sql,/NOT \(user_id=\$4::uuid AND session_id=ANY\(\$3::text\[\]\)\)/);
  assert.deepEqual(referencesCall.args.slice(2),[['session-a','session-b'],'22222222-2222-4222-8222-222222222222']);
  for (const bad of ['session-a',['x; DROP'],[1],Array(501).fill('session-a')]) {
    await assert.rejects(manageNativeEmployee(db,principal,{...input,reset_session_ids:bad}),/invalid_reset_session_ids/);
  }
});

test('reserved malformed lifecycle policies fail closed rather than reverting to legacy', () => {
  for (const native_lifecycle of [null, 'invalid', {version:2,phase:'active',kind:'durable'},
    {version:1,phase:'active',kind:'unknown'}, {version:1,phase:'active',kind:'temporary',expires_at:'invalid'}]) {
    assert.equal(employeeCanDispatch({status:'draft',policyRules:{native_lifecycle}},0),false);
  }
  assert.equal(employeeCanDispatch({status:'running',policyRules:{}},0),true);
});

const appearance = {version:1,provider:'humation',template:'humation-1',asset_version:'1.0.1',seed:'employee-1',
  selections:{head:'hm1-p-000001',body:'hm1-p-000025',bottom:'hm1-p-000033',item:'hm1-p-000041',glasses:'hm1-p-000056'},
  colors:{stroke:'000000',hair:'abcdef',skin:'fedcba',clothes:'112233',bottom:'445566'},background:'transparent',crop:'avatar'};
test('simple creation retains canonical local appearance and a bounded provisional persona', () => {
  const result=validateNativeCreation({operation:'create',creation_key:'new-employee',name:'Alex',appearance},0);
  assert.match(result.persona,/native question tool/);
  assert.equal(result.appearance.colors.hair,'ABCDEF');
  assert.equal(result.appearance.selections.item,'hm1-p-000041');
  for (const invalid of [{...appearance,selections:{...appearance.selections,head:'hm1-p-000025'}},
    {...appearance,colors:{...appearance.colors,skin:'#ffffff'}}, {...appearance,permissions:['write']}]) {
    assert.throws(()=>validateNativeCreation({...base,appearance:invalid},0),/invalid_employee_appearance/);
  }
});
test('profile refinement preserves lifecycle authority, appearance and permission configuration', async () => {
  const row={id:'11111111-1111-4111-8111-111111111111',name:'Alex',status:'draft',tools:[],enabledConnectors:[],
    policyRules:{appearance,native_lifecycle:{version:1,phase:'active',kind:'durable',revision:4,profile_revision:1}}};
  const tx={$queryRawUnsafe:async()=>[],digitalEmployee:{findFirst:async()=>row,update:async({data})=>Object.assign(row,data)}};
  const db={userOrganization:{findUnique:async()=>({isActive:true,role:'admin'})},$transaction:async fn=>fn(tx)};
  const principal={orgId:'org',userId:'admin'};
  const input={operation:'configure',employee_id:row.id,expected_profile_revision:1,role:'Research',persona:'Own evidence review.'};
  const result=await manageNativeEmployee(db,principal,input);
  assert.equal(result.employee.policyRules.native_lifecycle.revision,4);
  assert.equal(result.employee.policyRules.native_lifecycle.profile_revision,2);
  assert.deepEqual(result.employee.policyRules.appearance,appearance);
  assert.deepEqual(row.tools,[]);
  assert.deepEqual(row.enabledConnectors,[]);
  assert.equal((await manageNativeEmployee(db,principal,input)).replayed,true);
  await assert.rejects(manageNativeEmployee(db,principal,{...input,persona:'Different'}),/employee_profile_revision_conflict/);
  await assert.rejects(manageNativeEmployee(db,principal,{...input,tools:['write']}),/invalid_employee_configuration/);
  row.archivedAt=new Date();
  await assert.rejects(manageNativeEmployee(db,principal,input),/employee_profile_not_active/);
});

test('responsibility proposal requires Chief confirmation and freezes the first joining profile', async () => {
  const row={id:'11111111-1111-4111-8111-111111111111',name:'Alex',roleArchetype:'Specialist',status:'draft',tools:[],enabledConnectors:[],policyRules:{native_lifecycle:{version:1,phase:'active',kind:'durable',revision:1,profile_revision:1}}};
  const tx={$queryRawUnsafe:async(sql)=>{
    if(sql.includes('information_schema')) return [{table_schema:'hivemind'}];
    if(sql.includes('SELECT header')) return [{header:{agentPreset:'hivemind-hq'}}];
    if(sql.includes('SELECT event_type')) return [{event_type:'hivemind/session-owner',payload:{data:{id:null,slug:'runtime'}}}];
    return [];
  },digitalEmployee:{findFirst:async()=>row,update:async({data})=>Object.assign(row,data)}};
  const db={userOrganization:{findUnique:async()=>({isActive:true,role:'admin'})},$transaction:async fn=>fn(tx)};
  const principal={orgId:'org',userId:'admin'};
  await manageNativeEmployee(db,principal,{operation:'configure',employee_id:row.id,expected_profile_revision:1,role:'Research',persona:'Agreed research responsibilities.'});
  assert.equal(row.policyRules.native_lifecycle.profile_stage,'runtime_review');
  assert.equal(row.policyRules.native_lifecycle.onboarding_required,true);
  assert.equal(row.policyRules.native_lifecycle.joining_profile,undefined);
  await manageNativeEmployee(db,{...principal,runtimeSessionId:'chief'},{operation:'configure',employee_id:row.id,expected_profile_revision:2,role:'Research'});
  assert.equal(row.policyRules.native_lifecycle.profile_stage,'runtime_review');
  assert.equal(row.policyRules.native_lifecycle.joining_profile,undefined);
  const approved={operation:'configure',employee_id:row.id,expected_profile_revision:3,role:'Research',persona:'Company-relevant bounded instructions.'};
  await manageNativeEmployee(db,{...principal,runtimeSessionId:'chief'},approved);
  assert.equal(row.policyRules.native_lifecycle.profile_stage,'ready');
  assert.equal(row.policyRules.native_lifecycle.onboarding_required,false);
  const first=structuredClone(row.policyRules.native_lifecycle.joining_profile);
  assert.equal(first.role,'Research');assert.equal(first.profileRevision,4);
  assert.equal((await manageNativeEmployee(db,{...principal,runtimeSessionId:'chief'},approved)).replayed,true);
  await manageNativeEmployee(db,{...principal,runtimeSessionId:'chief'},{...approved,expected_profile_revision:4,persona:'Updated relevant instructions.'});
  assert.deepEqual(row.policyRules.native_lifecycle.joining_profile,first);
  assert.deepEqual(row.tools,[]);assert.deepEqual(row.enabledConnectors,[]);
});

test('appearance-only configuration is canonical, revision-guarded and preserves onboarding and permissions', async () => {
  const lifecycle={version:1,phase:'active',kind:'durable',revision:4,profile_revision:2,profile_stage:'ready',onboarding_required:false,profile_hash:'responsibility-hash',joining_profile:{name:'Alex'}};
  const row={id:'11111111-1111-4111-8111-111111111111',name:'Alex',status:'draft',tools:['read'],enabledConnectors:['gmail'],policyRules:{appearance,native_lifecycle:lifecycle,other:{keep:true}}};
  const tx={$queryRawUnsafe:async()=>[],digitalEmployee:{findFirst:async()=>row,update:async({data})=>Object.assign(row,data)}};
  const db={userOrganization:{findUnique:async()=>({isActive:true,role:'admin'})},$transaction:async fn=>fn(tx)};
  const principal={orgId:'org',userId:'admin'};
  const changed={...appearance,colors:{...appearance.colors,clothes:'123ABC'}};
  const input={operation:'configure',employee_id:row.id,expected_profile_revision:2,appearance:changed};
  const result=await manageNativeEmployee(db,principal,input);
  assert.equal(result.appearanceOnly,true);
  assert.equal(result.employee.policyRules.appearance.colors.clothes,'123ABC');
  assert.deepEqual(result.employee.policyRules.native_lifecycle,{...lifecycle,profile_revision:3});
  assert.deepEqual(row.tools,['read']);assert.deepEqual(row.enabledConnectors,['gmail']);assert.deepEqual(row.policyRules.other,{keep:true});
  assert.equal((await manageNativeEmployee(db,principal,input)).replayed,true);
  await assert.rejects(manageNativeEmployee(db,principal,{...input,appearance:{...changed,background:'000000'}}),/employee_profile_revision_conflict/);
  await assert.rejects(manageNativeEmployee(db,principal,{...input,appearance:null}),/invalid_employee_appearance/);
  await assert.rejects(manageNativeEmployee(db,principal,{...input,appearance:{...changed,permissions:['write']}}),/invalid_employee_appearance/);
  await assert.rejects(manageNativeEmployee(db,principal,{...input,tools:['write']}),/invalid_employee_configuration/);
});

test('remove deletes the employee row for good, archived or not, and only for an administrator', async () => {
  for (const archivedAt of [null, new Date()]) {
    const row={id:'11111111-1111-4111-8111-111111111111',name:'Zozo',status:'draft',archivedAt,
      policyRules:{native_lifecycle:{version:1,phase:'active',kind:'durable',revision:2,profile_revision:2}}};
    const deleted=[];
    const tx={$queryRawUnsafe:async()=>[],digitalEmployee:{findFirst:async()=>row,update:async()=>{throw Error('no update');},delete:async({where})=>{deleted.push(where.id);return row;}}};
    const db={userOrganization:{findUnique:async()=>({isActive:true,role:'admin'})},$transaction:async fn=>fn(tx)};
    const result=await manageNativeEmployee(db,{orgId:'org',userId:'admin'},{operation:'remove',employee_id:row.id});
    assert.equal(result.removed,true);
    assert.deepEqual(deleted,[row.id]);
  }
  const db={userOrganization:{findUnique:async()=>({isActive:true,role:'member'})},$transaction:async()=>{throw Error('no transaction');}};
  await assert.rejects(manageNativeEmployee(db,{orgId:'org',userId:'member'},{operation:'remove',employee_id:'11111111-1111-4111-8111-111111111111'}),/administrator_membership_required/);
});

test('pause_archive hides and pauses an employee reversibly; unarchive restores it; retired employees are never restorable', async () => {
  const id='11111111-1111-4111-8111-111111111111';
  const row={id,name:'Zozo',status:'ready',archivedAt:null,
    policyRules:{native_lifecycle:{version:1,phase:'active',kind:'durable',revision:2}}};
  const tx={$queryRawUnsafe:async()=>[],digitalEmployee:{findFirst:async()=>row,update:async({data})=>Object.assign(row,data)}};
  const db={userOrganization:{findUnique:async()=>({isActive:true,role:'admin'})},$transaction:async fn=>fn(tx)};
  const principal={orgId:'org',userId:'admin'};
  let result=await manageNativeEmployee(db,principal,{operation:'pause_archive',employee_id:id});
  assert.equal(result.replayed,false);assert.ok(result.employee.archivedAt);assert.equal(result.employee.status,'paused');
  assert.equal(result.employee.policyRules.native_lifecycle.archive.reversible,true);
  assert.equal(employeeCanDispatch(row,0),false);
  result=await manageNativeEmployee(db,principal,{operation:'pause_archive',employee_id:id});
  assert.equal(result.replayed,true);
  result=await manageNativeEmployee(db,principal,{operation:'unarchive',employee_id:id});
  assert.equal(result.replayed,false);assert.equal(row.archivedAt,null);assert.equal(row.status,'ready');
  assert.equal(row.policyRules.native_lifecycle.archive,undefined);assert.equal(row.policyRules.native_lifecycle.phase,'active');
  assert.equal(employeeCanDispatch(row,0),true);
  result=await manageNativeEmployee(db,principal,{operation:'unarchive',employee_id:id});
  assert.equal(result.replayed,true);
  Object.assign(row,{archivedAt:new Date(),status:'paused',policyRules:{native_lifecycle:{version:1,phase:'archived',revision:3}}});
  await assert.rejects(manageNativeEmployee(db,principal,{operation:'unarchive',employee_id:id}),/employee_not_restorable/);
  const member={userOrganization:{findUnique:async()=>({isActive:true,role:'member'})},$transaction:async()=>{throw Error('no transaction');}};
  await assert.rejects(manageNativeEmployee(member,principal,{operation:'pause_archive',employee_id:id}),/administrator_membership_required/);
});

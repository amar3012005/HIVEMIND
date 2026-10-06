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

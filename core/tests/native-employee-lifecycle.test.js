import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNativeCreation, employeeCanDispatch, requireLifecycleAdministrator } from '../src/employees/native-lifecycle.js';
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

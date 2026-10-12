import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { activateNativeEmployeeLifecycle, assertNativeEmployeeLifecycleConfigured } from '../src/employees/native-lifecycle-bridge.js';
const principal={orgId:'org',userId:'admin'}, employee={id:'employee'};
const env={HIVE_HARNESS_RUNNER_SERVICE_SECRET:'x'.repeat(32),HIVEMIND_EMPLOYEE_LIFECYCLE_URL:'https://runner.example/internal/hivemind/employee-lifecycle'};
test('missing or incorrect callback configuration never sends',async()=>{
 for(const configuration of [{},{...env,HIVEMIND_EMPLOYEE_LIFECYCLE_URL:'https://runner.example/wrong'}]) {
  const result=await activateNativeEmployeeLifecycle(principal,employee,{env:configuration,fetchImpl:()=>{throw Error('must not send');}});
  assert.equal(result.reason,'native_lifecycle_host_not_configured');
 }
});
test('callback binds the administrator and exact body to a purpose separated receipt',async()=>{
 const result=await activateNativeEmployeeLifecycle(principal,employee,{env,fetchImpl:async(url,options)=>{
  assert.equal(url.pathname,'/internal/hivemind/employee-lifecycle'); assert.equal(options.redirect,'error');
  const claims=JSON.parse(Buffer.from(options.headers.authorization.slice(7).split('.')[1],'base64url'));
  assert.equal(claims.aud,'hivemind-employee-lifecycle');assert.equal(claims.sub,'admin');assert.equal(claims.org_id,'org');
  assert.equal(claims.body_sha256,createHash('sha256').update(options.body).digest('hex'));
  return {ok:true,text:async()=>JSON.stringify({status:'ready',employeeId:'employee',scheduleId:'saved'})};
 }});assert.equal(result.scheduleId,'saved');
});
test('unknown delivery never claims activation succeeded',async()=>{
 const result=await activateNativeEmployeeLifecycle(principal,employee,{env,fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({status:'ready',employeeId:'other'})})});
 assert.equal(result.status,'pending');assert.equal(result.reason,'native_lifecycle_host_unconfirmed');
});

test('creation prerequisite rejects missing endpoint, invalid URL and short secret before mutation',()=>{
 for(const configuration of [{},{...env,HIVE_HARNESS_RUNNER_SERVICE_SECRET:'short'},{...env,HIVEMIND_EMPLOYEE_LIFECYCLE_URL:'https://runner.example/wrong'},{...env,HIVEMIND_EMPLOYEE_LIFECYCLE_URL:'https://user:password@runner.example/internal/hivemind/employee-lifecycle'}]) {
  let created=false;assert.throws(()=>{assertNativeEmployeeLifecycleConfigured(configuration);created=true;},error=>error.status===503&&error.message.includes('native_lifecycle_host_not_configured'));assert.equal(created,false);
 }
 assert.equal(assertNativeEmployeeLifecycleConfigured(env).pathname,'/internal/hivemind/employee-lifecycle');
});

test('bound Open Dot lifecycle callback replays only for the exact active bound profile', async () => {
  const { activateBoundOpenDotEmployee } = await import('../src/employees/native-lifecycle-bridge.js');
  const principal = { userId: '22222222-2222-4222-8222-222222222222', orgId: '33333333-3333-4333-8333-333333333333' };
  const employee = { id: '11111111-1111-4111-8111-111111111111', status: 'active', archivedAt: null,
    policyRules: { open_dot_employee: { version: 1, execution_backend: 'open-dot', state: 'bound', dot_id: 'dot-exact', binding_revision: 1 },
      native_lifecycle: { phase: 'active' } } };
  let calls = 0;
  const env = { HIVEMIND_EMPLOYEE_LIFECYCLE_URL: 'http://harness-runner:3080/internal/hivemind/employee-lifecycle',
    HIVE_HARNESS_RUNNER_SERVICE_SECRET: 'x'.repeat(48) };
  const fetchImpl = async (_url, options) => {
    calls++;
    const payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ status: 'ready', employeeId: payload.employeeId }), { status: 200 });
  };
  const first = await activateBoundOpenDotEmployee(principal, employee, { env, fetchImpl });
  assert.equal(first.status, 'ready');
  assert.equal(calls, 1);
  const replay = await activateBoundOpenDotEmployee(principal, employee, { env, fetchImpl });
  assert.equal(replay.status, 'ready');
  assert.equal(calls, 2);
  const paused = await activateBoundOpenDotEmployee(principal, { ...employee, status: 'paused' }, { env, fetchImpl });
  assert.equal(paused.status, 'pending');
  assert.equal(paused.reason, 'open_dot_employee_not_ready');
  assert.equal(calls, 2);
  const unbound = await activateBoundOpenDotEmployee(principal, { ...employee,
    policyRules: { ...employee.policyRules, open_dot_employee: { ...employee.policyRules.open_dot_employee, state: 'provisioning' } } }, { env, fetchImpl });
  assert.equal(unbound.status, 'pending');
  const noRevision = await activateBoundOpenDotEmployee(principal, { ...employee,
    policyRules: { ...employee.policyRules, open_dot_employee: { ...employee.policyRules.open_dot_employee, binding_revision: 0 } } }, { env, fetchImpl });
  assert.equal(noRevision.status, 'pending');
  const wrongBackend = await activateBoundOpenDotEmployee(principal, { ...employee,
    policyRules: { ...employee.policyRules, open_dot_employee: { ...employee.policyRules.open_dot_employee, execution_backend: 'native-dsh' } } }, { env, fetchImpl });
  assert.equal(wrongBackend.status, 'pending');
  const corrupt = await activateBoundOpenDotEmployee(principal, { ...employee,
    policyRules: { ...employee.policyRules, open_dot_employee: { ...employee.policyRules.open_dot_employee, version: 2 } } }, { env, fetchImpl });
  assert.equal(corrupt.status, 'pending');
  const missingDot = await activateBoundOpenDotEmployee(principal, { ...employee,
    policyRules: { ...employee.policyRules, open_dot_employee: { ...employee.policyRules.open_dot_employee, dot_id: '' } } }, { env, fetchImpl });
  assert.equal(missingDot.status, 'pending');
  assert.equal(calls, 2);
  const uncertain = await activateBoundOpenDotEmployee(principal, employee, { env, fetchImpl: async () => { throw Error('network'); } });
  assert.equal(uncertain.status, 'pending');
  assert.equal(uncertain.reason, 'native_lifecycle_host_unconfirmed');
  assert.equal(employee.policyRules.open_dot_employee.state, 'bound');
  assert.equal(calls, 2);
});

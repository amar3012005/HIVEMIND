import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { activateNativeEmployeeLifecycle } from '../src/employees/native-lifecycle-bridge.js';
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

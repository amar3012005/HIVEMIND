import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRunnerAdmissionGate } from '../../src/mobile/runner-readiness.js';
const native = {nativeMobile:true};
test('every native Harness namespace is fail-closed by default, including future admission aliases',()=>{
  for(const pathname of ['/v1/harness-chat','/v1/harness-chat/bootstrap','/v1/harness-chat/sessions','/v1/harness-chat/admission/future']) {
    assert.deepEqual(nativeRunnerAdmissionGate({pathname,method:'POST',session:native,env:{}}),{allowed:false,status:503,code:'MOBILE_RUNNER_NOT_READY'});
  }
});
test('only explicit true readiness opens native admission',()=>{
  for(const value of [undefined,'false','1','TRUE']) assert.equal(nativeRunnerAdmissionGate({pathname:'/v1/harness-chat/bootstrap',method:'POST',session:native,env:{HIVE_MOBILE_RUNNER_CONSENT_READY:value}}).allowed,false);
  assert.equal(nativeRunnerAdmissionGate({pathname:'/v1/harness-chat/bootstrap',method:'POST',session:native,env:{HIVE_MOBILE_RUNNER_CONSENT_READY:'true'}}).allowed,true);
});
test('browser, profile, consent, account deletion and existing session cleanup remain unchanged',()=>{
  for(const [pathname,method] of [['/v1/bootstrap','GET'],['/v1/mobile/privacy/ai-consent','POST'],['/v1/account','DELETE'],['/v1/harness-chat/sessions/id','DELETE'],['/v1/harness-chat/bootstrap','OPTIONS']]) assert.equal(nativeRunnerAdmissionGate({pathname,method,session:native,env:{}}).allowed,true);
  assert.equal(nativeRunnerAdmissionGate({pathname:'/v1/harness-chat/bootstrap',method:'POST',session:{},env:{}}).allowed,true);
});

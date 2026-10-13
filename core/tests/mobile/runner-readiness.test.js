import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRunnerAdmissionGate } from '../../src/mobile/runner-readiness.js';
const native = {nativeMobile:true};
test('native Harness namespaces proceed to the cryptographic Runner and consent checks',()=>{
  for(const pathname of ['/v1/harness-chat','/v1/harness-chat/bootstrap','/v1/harness-chat/sessions','/v1/harness-chat/admission/future']) {
    assert.deepEqual(nativeRunnerAdmissionGate({pathname,method:'POST',session:native}),{allowed:true});
  }
});
test('browser, profile, consent, account deletion and existing session cleanup remain unchanged',()=>{
  for(const [pathname,method] of [['/v1/bootstrap','GET'],['/v1/mobile/privacy/ai-consent','POST'],['/v1/account','DELETE'],['/v1/harness-chat/sessions/id','DELETE'],['/v1/harness-chat/bootstrap','OPTIONS']]) assert.equal(nativeRunnerAdmissionGate({pathname,method,session:native,env:{}}).allowed,true);
  assert.equal(nativeRunnerAdmissionGate({pathname:'/v1/harness-chat/bootstrap',method:'POST',session:{}}).allowed,true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { changeSessionOrganization, NATIVE_ORGANIZATION_UPDATE } from '../../src/mobile/session-organization.js';
test('native organization activation keeps OS token and does not create browser session', async()=>{
 let call;const current={sessionId:'native-token',session:{userId:'user-a',orgId:null,nativeMobile:true}};
 const value=await changeSessionOrganization({current,orgId:'org-a',sessionStore:{destroySession(){throw Error('must not destroy');},createSession(){throw Error('must not mint');}},mobileAuthStore:{client:async()=>({eval:async(...args)=>{call=args;return 1;}})}});
 assert.equal(value,'native-token');assert.equal(call[0],NATIVE_ORGANIZATION_UPDATE);assert.equal(call[2],'cp:session:native-token');assert.deepEqual(JSON.parse(call[3]),{userId:'user-a',orgId:null});assert.equal(call[4],'org-a');assert.match(call[0],/PTTL/);assert.match(call[0],/'PX',ttl/);
});
test('expired, revoked or concurrently changed native sessions fail closed',async()=>{await assert.rejects(()=>changeSessionOrganization({current:{sessionId:'x',session:{userId:'a',orgId:'old',nativeMobile:true}},orgId:'new',mobileAuthStore:{client:async()=>({eval:async()=>0})}}),e=>e.status===401);});
test('browser rotation preserves existing destroy/create behavior',async()=>{const calls=[];const result=await changeSessionOrganization({current:{sessionId:'old',session:{userId:'a',orgId:'old'}},orgId:'new',sessionStore:{destroySession:async id=>calls.push(id),createSession:async payload=>{calls.push(payload);return 'new-token';}}});assert.equal(result,'new-token');assert.deepEqual(calls,['old',{userId:'a',orgId:'new'}]);});

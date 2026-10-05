import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleHarnessChatBootstrapRoute } from '../../src/routes/harness-chat.js';
const secret = 'fixture-secret-with-at-least-thirty-two-bytes';
function token() {
  const now = Math.floor(Date.now()/1000);
  const encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const input = `${encode({alg:'HS256',typ:'JWT'})}.${encode({iss:'hivemind-harness-runner',aud:'hivemind-control-plane-harness-proxy',sub:'54f5568b-4d6a-4ae1-9a33-48cb2909d59b',org_id:'67503d34-97e9-49a8-8c52-8ee30cc7603e',profile:'hivemind-chat',iat:now,exp:now+30,jti:crypto.randomUUID()})}`;
  return `${input}.${crypto.createHmac('sha256',secret).update(input).digest('base64url')}`;
}
for (const [name, membership, method, invalid, status] of [
  ['active', {isActive:true}, 'GET', false, 200],
  ['inactive', {isActive:false}, 'GET', false, 403],
  ['missing', null, 'GET', false, 403],
  ['invalid signature', {isActive:true}, 'GET', true, 401],
  ['wrong method', {isActive:true}, 'POST', false, 405],
]) test(`principal validation ${name}`, async () => {
  const res={}; let downstream=false;
  await handleHarnessChatBootstrapRoute({req:{method,headers:{authorization:`Bearer ${invalid ? 'invalid' : token()}`}},res,
    pathname:'/internal/v1/harness-chat/core/principal',prisma:{userOrganization:{findUnique:async()=>membership}},
    env:{HIVE_HARNESS_RUNNER_SERVICE_SECRET:secret},parseBody:async()=>{throw Error('must not parse')},
    jsonResponse:(r,b,status=200)=>Object.assign(r,{body:b,status}),fetchImpl:async()=>{downstream=true;throw Error('must not proxy')},redisConfig:{}});
  assert.equal(res.status,status);assert.equal(downstream,false);
  if(status===200)assert.deepEqual(res.body,{active:true});
});

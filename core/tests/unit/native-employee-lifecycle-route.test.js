import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleHarnessChatBootstrapRoute } from '../../src/routes/harness-chat.js';
const secret = 'fixture-native-employee-service-secret-32-bytes';
const sub='54f5568b-4d6a-4ae1-9a33-48cb2909d59b';
const org='67503d34-97e9-49a8-8c52-8ee30cc7603e';
function token(extra={}) {
 const now=Math.floor(Date.now()/1000), encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const claims={iss:'hivemind-harness-runner',aud:'hivemind-control-plane-harness-proxy',sub,org_id:org,profile:'hivemind-chat',iat:now,exp:now+30,jti:crypto.randomUUID(),...extra};
 const input=`${encode({alg:'HS256',typ:'JWT'})}.${encode(claims)}`;
 return `${input}.${crypto.createHmac('sha256',secret).update(input).digest('base64url')}`;
}
test('native employee lifecycle rejects general chat and revoked membership before reading request', async()=>{
 for (const [claims,membership,expected] of [[{},true,403],[{operating_role:'runtime',operating_session:'runtime-fixture'},false,403]]) {
  const response={};let parsed=false;
  await handleHarnessChatBootstrapRoute({req:{method:'POST',headers:{authorization:`Bearer ${token(claims)}`}},res:response,pathname:'/internal/v1/harness-chat/core/employee-lifecycle',prisma:{userOrganization:{findUnique:async()=>({isActive:membership})}},parseBody:async()=>{parsed=true;return{};},jsonResponse:(r,b,status=200)=>Object.assign(r,{body:b,status}),redisConfig:{},env:{HIVE_HARNESS_RUNNER_SERVICE_SECRET:secret}});
  assert.equal(response.status,expected);assert.equal(parsed,false);
 }
});

test('authorized native creation with missing bridge fails before any employee mutation',async()=>{
 const response={};let wrote=false;
 await handleHarnessChatBootstrapRoute({req:{method:'POST',headers:{authorization:`Bearer ${token({operating_role:'runtime',operating_session:'runtime-fixture'})}`}},res:response,pathname:'/internal/v1/harness-chat/core/employee-lifecycle',prisma:{userOrganization:{findUnique:async()=>({isActive:true})},digitalEmployee:{create:async()=>{wrote=true;throw Error('must not create');}}},parseBody:async()=>({operation:'create'}),jsonResponse:(r,b,status=200)=>Object.assign(r,{body:b,status}),redisConfig:{},env:{HIVE_HARNESS_RUNNER_SERVICE_SECRET:secret}});
 assert.equal(response.status,503);assert.match(response.body.error,/native_lifecycle_host_not_configured/);assert.equal(wrote,false);
});

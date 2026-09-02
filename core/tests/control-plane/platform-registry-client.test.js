import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformRegistryClient, hashInviteToken, platformRegistryMode } from '../../src/control-plane/platform-registry-client.js';
test('feature mode fails closed',()=>{ assert.equal(platformRegistryMode('unexpected'),'off'); assert.equal(platformRegistryMode('shadow'),'shadow'); });
test('client performs no network work while disabled',async()=>{ let calls=0; const client=new PlatformRegistryClient({mode:'off',fetchImpl:async()=>{calls++;}}); assert.deepEqual(await client.mirror({}),{skipped:true,reason:'disabled'}); assert.equal(calls,0); });
test('invite digest never equals raw token',()=>assert.notEqual(hashInviteToken('opaque-token'),'opaque-token'));
test('client sends only the supplied event to the internal endpoint', async()=>{
  let request; const client=new PlatformRegistryClient({mode:'shadow',baseUrl:'https://registry.example',secret:'test',fetchImpl:async(url, init)=>{request={url,init};return new Response(JSON.stringify({ok:true}),{status:200});}});
  await client.mirror({event_id:'event',entity_type:'api_key'});
  assert.equal(request.url,'https://registry.example/internal/v1/registry/events');
  assert.equal(request.init.headers.authorization,'Bearer test');
});

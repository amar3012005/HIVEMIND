import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { MobileAuthStore } from '../../src/mobile/auth-store.js';
import { handleMobileAuthRoutes, MOBILE_CALLBACK, mobileOAuthIntent, completeMobileOAuth } from '../../src/mobile/auth-routes.js';
const verifier='v'.repeat(43); const state='s'.repeat(43);
const challenge=createHash('sha256').update(verifier).digest('base64url');
// Deterministic atomic Redis adapter. Real Redis Lua verification is a separate integration gate.
class Redis {
  records=new Map();
  async set(k,v){this.records.set(k,v);return 'OK';}
  async get(k){return this.records.get(k) || null;}
  async eval(script,_count,key,a,b){
    const raw=this.records.get(key);if(!raw)return null;const rec=JSON.parse(raw);
    if(script.includes('browserUserId')){
      if(script.includes('PTTL')){if(rec.browserUserId && rec.browserUserId!==a)return null;rec.browserUserId=a;const next=JSON.stringify(rec);this.records.set(key,next);return next;}
    }
    const expected=JSON.parse(a);if(Object.entries(expected).some(([k,v])=>rec[k]!==v))return null;
    if(rec.expiresAt<=Number(b)){this.records.delete(key);return null;}
    this.records.delete(key);return raw;
  }
}
function fixture(){const redis=new Redis();let time=1000;const store=new MobileAuthStore({}, {redis:async()=>redis,now:()=>time});let user={sessionId:'browser',session:{userId:'user-a',email:'a@example.test',orgId:'org-a'}};let membership=true;
  async function request(path,method='GET',body={},origin,contentType='application/json'){
    const serialized=contentType==='application/x-www-form-urlencoded' ? new URLSearchParams(body).toString() : JSON.stringify(body);
    const req=Readable.from(method==='POST' ? [serialized] : []);req.method=method;req.headers={host:'api.example.test','content-type':contentType,...(origin?{origin}:{})};
    let status,headers={},data;
    const res={setHeader:(k,v)=>headers[k]=v,writeHead:(s,h={})=>{status=s;headers={...headers,...h};},end:x=>data=x};
    const url=new URL(path,'https://api.example.test');
    await handleMobileAuthRoutes({req,res,pathname:url.pathname,url,store,sessionStore:{destroySession:async token=>redis.records.delete(`cp:session:${token}`)},getCurrentSession:async()=>user,jsonResponse:(_r,v,s,h)=>{status=s;data=v;headers={...headers,...h};},allowedOrigins:['https://api.example.test'],frontendBase:'https://next.example.test',membershipActive:async()=>membership});
    return {status,headers,data};
  }
  return {store,redis,request,setUser:x=>user=x,setMembership:x=>membership=x,setTime:x=>time=x};
}
async function grant(f){const started=await f.request(`/auth/mobile/start?callback=${encodeURIComponent(MOBILE_CALLBACK)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`);assert.equal(started.status,303);const intent=new URL(started.headers.Location).searchParams.get('intent');const page=await f.request(`/auth/mobile/authorize?intent=${intent}`);assert.equal(page.status,200);const nonce=(await f.store.get('intent',intent)).nonce;const confirmed=await f.request('/auth/mobile/authorize','POST',{intent,nonce},'https://api.example.test');assert.equal(confirmed.status,303);return new URL(confirmed.headers.Location).searchParams.get('code');}
const exchange=(code,extras={})=>({code,state,callback:MOBILE_CALLBACK,code_verifier:verifier,...extras});
test('PKCE grant returns dedicated revocable session, not browser session/API key',async()=>{const f=fixture();const code=await grant(f);const response=await f.request('/auth/mobile/exchange','POST',exchange(code),'capacitor://localhost');assert.equal(response.status,200);assert.notEqual(response.data.session_token,'browser');assert.equal(response.data.expires_in,3600);const session=JSON.parse(await f.redis.get(`cp:session:${response.data.session_token}`));assert.equal(session.userId,'user-a');assert.equal(session.nativeMobile,true);f.setUser({sessionId:response.data.session_token,session});assert.equal((await f.request('/auth/mobile/revoke','POST',{},'capacitor://localhost')).status,200);assert.equal(await f.redis.get(`cp:session:${response.data.session_token}`),null);});
test('rejects callback, PKCE method and short state',async()=>{const f=fixture();for(const extra of ['callback=singulance://evil/callback','state=short','code_challenge_method=plain']){const q=new URLSearchParams({callback:MOBILE_CALLBACK,state,code_challenge:challenge,code_challenge_method:'S256'});const [k,v]=extra.split('=');q.set(k,v);assert.equal((await f.request(`/auth/mobile/start?${q}`)).status,400);}});
test('wrong proof/state/callback cannot consume legitimate code; concurrent replay yields only one session',async()=>{const f=fixture();const code=await grant(f);for(const extras of [{state:'x'.repeat(43)},{callback:'singulance://other/callback'},{code_verifier:'x'.repeat(43)}])assert.ok((await f.request('/auth/mobile/exchange','POST',exchange(code,extras),'https://localhost')).status>=400);const replies=await Promise.all([f.request('/auth/mobile/exchange','POST',exchange(code),'https://localhost'),f.request('/auth/mobile/exchange','POST',exchange(code),'https://localhost')]);assert.deepEqual(replies.map(x=>x.status).sort(),[200,401]);});
test('expired or inactive membership grants do not create session; origin spoof denied',async()=>{const f=fixture();let code=await grant(f);assert.equal((await f.request('/auth/mobile/exchange','POST',exchange(code),'https://evil.test')).status,403);f.setTime(100000);assert.equal((await f.request('/auth/mobile/exchange','POST',exchange(code),'https://localhost')).status,401);const other=fixture();code=await grant(other);other.setMembership(false);assert.equal((await other.request('/auth/mobile/exchange','POST',exchange(code),'https://localhost')).status,403);});
test('browser confirmation is user bound and CSRF protected',async()=>{const f=fixture();const intent=await f.store.put('intent',{callback:MOBILE_CALLBACK,state,challenge,nonce:'nonce'},300);await f.request(`/auth/mobile/authorize?intent=${intent}`);assert.equal((await f.request('/auth/mobile/authorize','POST',{intent,nonce:'nonce'},'https://evil.test')).status,403);f.setUser({sessionId:'b',session:{userId:'user-b',orgId:'org-b'}});assert.equal((await f.request('/auth/mobile/authorize','POST',{intent,nonce:'nonce'},'https://api.example.test')).status,403);});
test('Redis unavailable fails closed, local origins allowed only on exchange/revoke',async()=>{const store=new MobileAuthStore({}, {redis:async()=>null});await assert.rejects(()=>store.put('code',{},60),error=>error.status===503);const f=fixture();assert.equal((await f.request('/auth/mobile/exchange','OPTIONS',{},'capacitor://localhost')).headers['Access-Control-Allow-Origin'],'capacitor://localhost');assert.equal((await f.request('/auth/mobile/start','OPTIONS',{},'capacitor://localhost')).headers['Access-Control-Allow-Origin'],undefined);});
test('existing verified account without organization can obtain onboarding session',async()=>{const f=fixture();f.setUser({sessionId:'browser',session:{userId:'user-a',email:'a@example.test',orgId:null}});const code=await grant(f);const response=await f.request('/auth/mobile/exchange','POST',exchange(code),'https://localhost');assert.equal(response.status,200);assert.equal(response.data.org_id,null);assert.equal(JSON.parse(await f.redis.get(`cp:session:${response.data.session_token}`)).orgId,null);});

test('browser consent form is accepted as urlencoded and emits no raw token',async()=>{const f=fixture();const intent=await f.store.put('intent',{callback:MOBILE_CALLBACK,state,challenge,nonce:'nonce'},300);await f.request(`/auth/mobile/authorize?intent=${intent}`);const response=await f.request('/auth/mobile/authorize','POST',{intent,nonce:'nonce'},'https://api.example.test','application/x-www-form-urlencoded');assert.equal(response.status,303);assert.equal(new URL(response.headers.Location).searchParams.get('token'),null);assert.ok(new URL(response.headers.Location).searchParams.get('code'));});

test('native OAuth returns directly through a single-use PKCE grant without a confirmation page', async () => {
  const f = fixture();
  const start = await f.request(`/auth/mobile/start?callback=${encodeURIComponent(MOBILE_CALLBACK)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&flow=native`);
  const oauth = new URL(start.headers.Location);
  assert.equal(oauth.pathname, '/auth/google');
  const returnTo = oauth.searchParams.get('return_to');
  const intent = await mobileOAuthIntent(f.store, returnTo, 'https://api.example.test');
  assert.ok(intent);
  assert.equal((await f.request(new URL(returnTo).pathname + new URL(returnTo).search)).status, 400);
  assert.equal(await mobileOAuthIntent(f.store, returnTo.replace('api.example.test', 'evil.test'), 'https://api.example.test'), null);
  const callback = new URL(await completeMobileOAuth(f.store, intent, {userId:'user-a',email:'a@example.test',orgId:'org-a'}));
  assert.equal(callback.protocol, 'singulance:');
  assert.equal(callback.searchParams.get('state'), state);
  const result = await f.request('/auth/mobile/exchange', 'POST', exchange(callback.searchParams.get('code')), 'capacitor://localhost');
  assert.equal(result.status, 200);
  await assert.rejects(() => completeMobileOAuth(f.store, intent, {userId:'user-a'}));
});

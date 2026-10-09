import { createHash, randomBytes } from 'node:crypto';
export const MOBILE_CALLBACK = 'singulance://auth/callback';
export const MOBILE_ORIGINS = Object.freeze(['capacitor://localhost', 'https://localhost']);
const challengeOf = (verifier) => createHash('sha256').update(verifier).digest('base64url');
const STATE = /^[A-Za-z0-9_-]{32,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const html = (text) => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function readBody(req) {
  const chunks=[];let size=0;
  for await(const chunk of req) { size+=Buffer.byteLength(chunk);if(size>8192) throw Object.assign(new Error('Request too large'),{status:413});chunks.push(Buffer.from(chunk)); }
  const raw=Buffer.concat(chunks).toString('utf8');
  try { return String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('Invalid body'),{status:400}); }
}
function publicOrigin(req, allowedOrigins, configuredBase) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const authorities = configuredBase ? [configuredBase] : allowedOrigins;
  const match = authorities.find(value => { try { const u = new URL(value); return u.protocol === 'https:' && u.host === host; } catch { return false; } });
  if (!match) throw Object.assign(new Error('Untrusted authentication authority'), { status: 403 });
  return new URL(match).origin;
}
export async function handleMobileAuthRoutes({ req, res, pathname, url, store, sessionStore, getCurrentSession, parseBody, jsonResponse, allowedOrigins, frontendBase, publicBaseUrl, membershipActive }) {
  if (!pathname.startsWith('/auth/mobile/')) return false;
  const send = (value, status=200) => { jsonResponse(res, value, status, {'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}); return true; };
  try {
    const origin = req.headers.origin;
    const publicBase = publicOrigin(req, allowedOrigins, publicBaseUrl);
    if (pathname === '/auth/mobile/exchange' || pathname === '/auth/mobile/revoke') {
      // Native grant exchange only: this does not widen application CORS.
      if (origin && !MOBILE_ORIGINS.includes(origin) && origin !== publicBase) return send({error:'Origin denied'},403);
      if (MOBILE_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin',origin); res.setHeader('Vary','Origin');
        res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    }
    if (pathname === '/auth/mobile/start' && req.method === 'GET') {
      const callback=url.searchParams.get('callback'); const state=url.searchParams.get('state');
      const challenge=url.searchParams.get('code_challenge'); const method=url.searchParams.get('code_challenge_method');
      if (callback !== MOBILE_CALLBACK || !STATE.test(state || '') || !CHALLENGE.test(challenge || '') || method !== 'S256') return send({error:'Invalid native authorization request'},400);
      const nonce=randomBytes(32).toString('base64url');
      const intent=await store.put('intent',{callback,state,challenge,nonce},300);
      const target=`${publicBase}/auth/mobile/authorize?intent=${encodeURIComponent(intent)}`;
      res.writeHead(303,{Location:target,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}); res.end(); return true;
    }
    if (pathname === '/auth/mobile/authorize' && ['GET','POST'].includes(req.method)) {
      const body=req.method === 'POST' ? await readBody(req) : {};
      const intent=req.method === 'POST' ? body.intent : url.searchParams.get('intent');
      const record=await store.get('intent',intent); if(!record) return send({error:'Authorization expired'},400);
      const current=await getCurrentSession(req);
      if(!current) {
        if(req.method==='POST') return send({error:'Unauthorized'},401);
        const returnTo=`${publicBase}/auth/mobile/authorize?intent=${encodeURIComponent(intent)}`;
        res.writeHead(303,{Location:`${frontendBase}/hivemind/login?mobile_return_to=${encodeURIComponent(returnTo)}`,'Cache-Control':'no-store'}); res.end(); return true;
      }
      if(req.method==='GET') {
        if(!await store.bindUser(intent,current.session.userId)) return send({error:'Authorization account changed'},403);
        // A browser explicitly confirms mobile-session creation; no code issued by link scanners.
        const page=`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect SINGULANCE</title><body><h1>Connect your SINGULANCE app</h1><p>Continue as ${html(current.session.email || 'your signed-in account')}?</p><form method="post" action="/auth/mobile/authorize"><input type="hidden" name="intent" value="${html(intent)}"><input type="hidden" name="nonce" value="${html(record.nonce)}"><button type="submit">Connect app</button></form><p>Close this page to cancel.</p></body></html>`;
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(page);return true;
      }
      if(origin!==publicBase || body.nonce!==record.nonce || record.browserUserId!==current.session.userId) return send({error:'Authorization confirmation denied'},403);
      if(!await membershipActive(current.session)) return send({error:'Account or membership unavailable'},403);
      const consumed=await store.consume('intent',intent,{nonce:body.nonce,browserUserId:current.session.userId}); if(!consumed) return send({error:'Authorization expired'},400);
      const code=await store.put('code',{callback:record.callback,state:record.state,challenge:record.challenge,userId:current.session.userId,email:current.session.email,orgId:current.session.orgId || null},60);
      const callback=new URL(MOBILE_CALLBACK); callback.searchParams.set('code',code);callback.searchParams.set('state',record.state);
      res.writeHead(303,{Location:callback.toString(),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();return true;
    }
    if(pathname === '/auth/mobile/exchange' && req.method === 'POST') {
      const body=await readBody(req);
      if(body.callback!==MOBILE_CALLBACK || !STATE.test(body.state || '') || !VERIFIER.test(body.code_verifier || '')) return send({error:'Invalid exchange'},400);
      const record=await store.consume('code',body.code,{callback:MOBILE_CALLBACK,state:body.state,challenge:challengeOf(body.code_verifier)});
      if(!record) return send({error:'Invalid or expired authorization code'},401);
      if(!await membershipActive(record)) return send({error:'Account or membership unavailable'},403);
      // This is a distinct revocable CP session, never the browser session or a broad API key.
      const token=await store.createNativeSession({userId:record.userId,email:record.email,orgId:record.orgId});
      return send({session_token:token,token_type:'Bearer',expires_in:3600,user_id:record.userId,org_id:record.orgId});
    }
    if(pathname === '/auth/mobile/revoke' && req.method === 'POST') {
      const current=await getCurrentSession(req); if(!current || !current.session.nativeMobile) return send({error:'Unauthorized'},401);
      await sessionStore.destroySession(current.sessionId);return send({success:true});
    }
    return send({error:'Not found'},404);
  } catch(error) { return send({error:error.status===503 ? 'Native authentication temporarily unavailable' : 'Native authentication failed'},error.status || 500); }
}

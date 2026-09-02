import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadEngineBoxRuntime } from './runtime.js';
import { getLocalPrismaClient } from './local-prisma.mjs';
import { assertActivationRecord, createSetupRecord, redactSetupRecord } from '../../../engine-box/lib/setup-contract.mjs';
import {
  consumeSetupToken,
  readActivationReceipt,
  readSetupRecord,
  redactStoredSetup,
  verifySetupToken,
  writeActivationReceipt,
  writeSetupRecord,
} from '../../../engine-box/lib/local-state.mjs';
import { createLocalApiKey, requireLocalAccess, resolveLocalPrincipal } from '../../../engine-box/lib/local-auth.mjs';

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function setupPage() {
  // Deliberately dependency-free: the bootstrap UI must remain available when
  // the customer has no package registry, CDN, or Internet route.
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HIVEMIND Engine Box setup</title>
<style>body{font:16px system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;color:#17202a}h1{margin-bottom:4px}fieldset{border:1px solid #d9dee7;border-radius:10px;margin:20px 0;padding:18px}label{display:block;font-weight:600;margin:10px 0 4px}input,select,textarea{box-sizing:border-box;width:100%;padding:9px;border:1px solid #aab4c3;border-radius:6px;font:inherit}button{margin-top:18px;padding:10px 14px;background:#146cff;border:0;border-radius:6px;color:white;font-weight:700;cursor:pointer}.hint{color:#5a6470}.status{white-space:pre-wrap;padding:12px;border-radius:6px;background:#f3f6fa}.warn{color:#8a4a00}</style>
<h1>Set up your HIVEMIND Engine Box</h1><p class="hint">All configuration is saved locally and encrypted. This page is available only through the local appliance.</p>
<div id="status" class="status">Checking local setup state…</div>
<form id="setup"><fieldset><legend>1. Local access</legend><p class="hint">Loopback stays the default. LAN HTTPS is enabled only after local certificate validation.</p><label>Access mode<select name="access_mode"><option value="loopback">Loopback only</option><option value="lan_https">LAN HTTPS</option></select></label><label>LAN hostname (only for LAN HTTPS)<input name="lan_hostname" placeholder="hivemind.internal.example"></label></fieldset>
<fieldset><legend>2. Customer OIDC</legend><label>Issuer URL<input required name="issuer" type="url" placeholder="https://id.example.com"></label><label>Client ID<input required name="client_id"></label><label>Client secret<input required name="client_secret" type="password" autocomplete="new-password"></label><label>Redirect URL<input required name="redirect_url" type="url" value="https://localhost/oauth2/callback"></label><label>Owner group<input name="owner_group" placeholder="hivemind-owners"></label></fieldset>
<fieldset><legend>3. Customer-local models</legend><p class="hint">Use the OpenAI-compatible API base URL (usually ending in <code>/v1</code>). All three routes remain on your network; Cloudflare AI Gateway is disabled by default.</p><label>Embedding endpoint<input required name="embedding_url" type="url"></label><label>Embedding model<input required name="embedding_model"></label><label>Embedding API key (if required)<input name="embedding_key" type="password" autocomplete="new-password"></label><label>Embedding dimension<input required name="embedding_dimension" type="number" min="1" value="1024"></label><label>Rerank endpoint<input required name="rerank_url" type="url"></label><label>Rerank model<input required name="rerank_model"></label><label>Rerank API key (if required)<input name="rerank_key" type="password" autocomplete="new-password"></label><label>Chat endpoint<input required name="chat_url" type="url"></label><label>Chat model<input required name="chat_model"></label><label>Chat API key (if required)<input name="chat_key" type="password" autocomplete="new-password"></label></fieldset>
<fieldset><legend>4. Encrypted backup</legend><label>Backup destination<input required name="backup_destination" placeholder="file:///mnt/hivemind-backups"></label><label>Customer key reference<input required name="backup_key_reference" placeholder="kms://customer/hivemind-backups"></label></fieldset><label>One-time setup token<input required name="setup_token" type="password" autocomplete="off"></label><button type="submit">Save local configuration</button></form>
<script>const s=document.querySelector('#status'),f=document.querySelector('#setup');async function status(){const r=await fetch('/v1/setup/status');s.textContent=JSON.stringify(await r.json(),null,2)}status();f.onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(f));const route=(kind)=>({execution:'local',base_url:d[kind+'_url'],model:d[kind+'_model'],...(d[kind+'_key']?{api_key:d[kind+'_key']}:{}),...(kind==='embedding'?{dimension:Number(d.embedding_dimension)}:{})});const payload={access:{mode:d.access_mode,hostname:d.lan_hostname||null},oidc:{issuer:d.issuer,client_id:d.client_id,client_secret:d.client_secret,redirect_url:d.redirect_url,group_mapping:d.owner_group?{owner:[d.owner_group]}:{}},model_routes:{embedding:route('embedding'),rerank:route('rerank'),chat:route('chat')},backup:{destination:d.backup_destination,encryption_key_reference:d.backup_key_reference}};const r=await fetch('/v1/setup/configure',{method:'POST',headers:{'content-type':'application/json','x-engine-box-setup-token':d.setup_token},body:JSON.stringify(payload)});s.textContent=JSON.stringify(await r.json(),null,2);if(r.ok){for(const input of f.querySelectorAll('input[type=password]'))input.value='';s.className='status warn';s.textContent+='\n\nConfiguration is saved. The appliance will remain unavailable until its authenticated functional canary is implemented and passed.'}}</script>`;
}

async function readJson(req, maxBytes = 256 * 1024) {
  let total = 0;
  const parts = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 }); }
}

function setupToken(req) {
  const token = req.headers['x-engine-box-setup-token'];
  return typeof token === 'string' ? token : '';
}

async function requireActivatedOwner(req, env) {
  const [record, activation] = await Promise.all([readSetupRecord(env), readActivationReceipt(env)]);
  if (!record || activation?.state !== 'active') throw Object.assign(new Error('local_appliance_not_activated'), { statusCode: 503 });
  const principal = resolveLocalPrincipal({ headers: req.headers, record });
  requireLocalAccess(principal, { role: 'owner' });
  return { record, principal };
}

/**
 * Engine Box deliberately does not boot src/control-plane-server.js. That
 * hosted entrypoint imports onboarding, connector, employee, and workflow
 * machinery which cannot exist in a content-local appliance. This small
 * process is the local authority seam; feature routes are added here only
 * after their RBAC and tenancy contract is certified.
 */
export function createEngineBoxControlPlane({ runtime, postgresProbe, env = process.env,
  canaryRunner = null, now = () => new Date().toISOString() }) {
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    try {
      if (pathname === '/v1/setup/status' && req.method === 'GET') {
        const [record, activation] = await Promise.all([readSetupRecord(env), readActivationReceipt(env)]);
        return send(res, 200, {
          setup: record ? redactStoredSetup(record) : null,
          activation: activation || null,
          state: activation?.state === 'active' ? 'ACTIVE' : record ? 'CONFIGURED' : 'BOOTSTRAP',
        });
      }
      if (pathname === '/setup' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(setupPage());
      }
      if (pathname === '/v1/setup/configure' && req.method === 'POST') {
        if (!(await verifySetupToken(setupToken(req), env))) return send(res, 401, { error: 'invalid_or_expired_setup_token' });
        const input = await readJson(req);
        const record = createSetupRecord(input, { now: now() });
        await writeSetupRecord({ ...record, oidc: { ...record.oidc, client_secret: input.oidc.client_secret } }, env);
        return send(res, 201, { setup: redactSetupRecord(record), state: 'CONFIGURED' });
      }
      if (pathname === '/v1/setup/activate' && req.method === 'POST') {
        if (!(await consumeSetupToken(setupToken(req), env))) return send(res, 401, { error: 'invalid_or_expired_setup_token' });
        const record = await readSetupRecord(env);
        const canary = typeof canaryRunner === 'function'
          ? await canaryRunner({ record, env })
          : { state: 'pending', receipt_id: null };
        assertActivationRecord(record || {}, canary);
        const receipt = { state: 'active', activated_at: now(), canary };
        await writeActivationReceipt(receipt, env);
        return send(res, 200, { state: 'ACTIVE', receipt });
      }

      if (pathname === '/v1/admin/status' && req.method === 'GET') {
        const { record, principal } = await requireActivatedOwner(req, env);
        return send(res, 200, { state: 'READY', principal: { kind: principal.kind, id: principal.id, roles: principal.roles }, setup: redactStoredSetup(record) });
      }
      if (pathname === '/v1/admin/api-keys' && req.method === 'POST') {
        const { record, principal } = await requireActivatedOwner(req, env);
        const input = await readJson(req);
        const created = createLocalApiKey({ name: input.name, scopes: input.scopes, expiresAt: input.expires_at || null });
        const next = { ...record, api_keys: [...(record.api_keys || []), created.record] };
        await writeSetupRecord(next, env);
        return send(res, 201, { api_key: created.raw, record: { ...created.record, key_hash: undefined }, created_by: principal.id });
      }
      const revoke = pathname.match(/^\/v1\/admin\/api-keys\/([^/]+)$/);
      if (revoke && req.method === 'DELETE') {
        const { record } = await requireActivatedOwner(req, env);
        const id = decodeURIComponent(revoke[1]);
        const found = (record.api_keys || []).some((key) => key.id === id && !key.revoked_at);
        if (!found) return send(res, 404, { error: 'local_api_key_not_found' });
        await writeSetupRecord({ ...record, api_keys: record.api_keys.map((key) => key.id === id ? { ...key, revoked_at: now() } : key) }, env);
        return send(res, 200, { revoked: true, id });
      }

      if (pathname !== '/health' && pathname !== '/ready') return send(res, 404, { error: 'not_found' });
      const postgres = await postgresProbe();
      const configured = await readSetupRecord(env);
      const activation = await readActivationReceipt(env);
      const ready = postgres === 'ready' && activation?.state === 'active';
      if (pathname === '/health') return send(res, 200, { ok: true, service: 'hm-control-plane', state: ready ? 'READY' : 'DEGRADED' });
      return send(res, ready ? 200 : 503, {
        state: ready ? 'READY' : 'UNAVAILABLE',
        api_version: runtime.apiVersion,
        setup_state: activation?.state === 'active' ? 'ACTIVE' : configured ? 'CONFIGURED' : 'BOOTSTRAP',
        capabilities: runtime.capabilities.filter((name) => ['identity', 'rbac', 'api_keys', 'licence', 'admin', 'audit'].includes(name)),
      });
    } catch (error) {
      const authErrors = new Set(['local_auth_required', 'local_api_key_invalid', 'local_role_unmapped', 'local_role_forbidden', 'local_scope_forbidden']);
      const status = error?.statusCode || (authErrors.has(error?.message) ? (error.message === 'local_auth_required' || error.message === 'local_api_key_invalid' ? 401 : 403) : 500);
      return send(res, status, { error: status >= 500 ? 'local_control_plane_failed' : error.message, message: error.message });
    }
  });
}

export async function startEngineBoxControlPlane(env = process.env) {
  const runtime = loadEngineBoxRuntime(env);
  if (!runtime.enabled) throw new Error('ENGINE_BOX_MODE=true is required for the Engine Box Control Plane');
  const prisma = getLocalPrismaClient(env);
  const postgresProbe = async () => {
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      return 'ready';
    } catch {
      return 'unavailable';
    }
  };
  const server = createEngineBoxControlPlane({ runtime, postgresProbe });
  const port = Number(env.CONTROL_PLANE_PORT || 3001);
  server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ svc: 'hm-control-plane', event: 'listening', port, mode: 'engine_box' })));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await startEngineBoxControlPlane();

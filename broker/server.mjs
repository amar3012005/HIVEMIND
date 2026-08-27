// Canonical Memory Box lifecycle authority. PostgreSQL owns identity,
// credentials and health; byod-agents.json is only Core's compatibility view.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import Pg from 'pg';
import { provisionTunnel, checkTunnelProvisioningReady } from './cloudflare-tunnel.mjs';
import { validateEndpoint } from './endpoint-policy.mjs';

const PORT = Number(process.env.BROKER_PORT || 8790);
const REG = process.env.MNEME_AGENT_REGISTRY_FILE || die('MNEME_AGENT_REGISTRY_FILE required');
const INTERNAL_TOKEN = process.env.BYOD_BROKER_INTERNAL_TOKEN || die('BYOD_BROKER_INTERNAL_TOKEN required');
const pool = new Pg.Pool({ connectionString: process.env.DATABASE_URL || die('DATABASE_URL required'), max: 8 });
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const issueToken = () => `hmb_${crypto.randomBytes(32).toString('base64url')}`;
const durableTokenForEnrollment = (raw) => `hmb_${crypto.createHmac('sha256', INTERNAL_TOKEN).update(`box:${raw}`).digest('base64url')}`;
const envelopeKey = crypto.createHash('sha256').update(`memory-box-envelope:${INTERNAL_TOKEN}`).digest();
function seal(value) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', envelopeKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}
function unseal(value) {
  const [iv, tag, ciphertext] = String(value || '').split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv?.length || !tag?.length || !ciphertext?.length) throw new Error('invalid credential envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', envelopeKey, iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function die(message) { console.error(`[hm-broker] ${message}`); process.exit(1); }
const send = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (chunk) => { size += chunk.length; if (size > 32768) { reject(Object.assign(new Error('request body too large'), { statusCode: 413 })); req.destroy(); } else chunks.push(chunk); });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 })); } });
  req.on('error', reject);
});
function loadReg(strict = false) {
  try { return existsSync(REG) ? JSON.parse(readFileSync(REG, 'utf8')) : {}; }
  catch (error) { if (strict) throw Object.assign(new Error('Memory Box registry is invalid'), { statusCode: 503, cause: error }); return {}; }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function withRegistryLock(mutator) {
  const lock = `${REG}.lock`; let fd;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { fd = openSync(lock, 'wx', 0o600); break; } catch (error) { if (error.code !== 'EEXIST') throw error; await delay(25); }
  }
  if (fd === undefined) throw Object.assign(new Error('Memory Box registry is busy'), { statusCode: 503 });
  try {
    const registry = loadReg(true); await mutator(registry);
    const temp = `${REG}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temp, JSON.stringify(registry), { encoding: 'utf8', mode: 0o600 }); renameSync(temp, REG);
  } finally { closeSync(fd); try { unlinkSync(lock); } catch {} }
}
function isInternal(req) {
  if (!INTERNAL_TOKEN) return false;
  const supplied = String(req.headers['x-hivemind-internal-token'] || '');
  return supplied.length === INTERNAL_TOKEN.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(INTERNAL_TOKEN));
}
async function apiPrincipal(raw) {
  if (!raw) return null;
  const { rows } = await pool.query(`SELECT k.id,k.org_id,k.scopes FROM api_keys k JOIN organizations o ON o.id=k.org_id
    WHERE k.key_hash=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
      AND o.hosting_mode='self_host' LIMIT 1`, [sha256(raw)]);
  if (!rows[0]) return null;
  const scopes = rows[0].scopes || [];
  const kind = scopes.includes('selfhost:bootstrap') ? 'bootstrap' : scopes.includes('selfhost:connect') ? 'connector' : null;
  return kind ? { ...rows[0], kind, raw: String(raw) } : null;
}
async function boxPrincipal(raw) {
  if (!raw) return null;
  const { rows } = await pool.query(`SELECT org_id,box_id FROM memory_box_connections WHERE credential_hash=$1 AND revoked_at IS NULL LIMIT 1`, [sha256(raw)]);
  return rows[0] ? { ...rows[0], kind: 'box' } : null;
}
async function enrollmentPrincipal(body) { const p = await apiPrincipal(body.enrollmentToken); return p?.kind === 'bootstrap' ? p : null; }
async function connectorPrincipal(body) { const p = await apiPrincipal(body.apiKey); return p?.kind === 'connector' ? p : null; }
async function registrationEnrollmentPrincipal(body) {
  const raw = String(body.enrollmentToken || ''); if (!raw) return null;
  const { rows } = await pool.query(`SELECT k.id,k.org_id,k.scopes,k.revoked_at,k.revoked_reason FROM api_keys k JOIN organizations o ON o.id=k.org_id
    WHERE k.key_hash=$1 AND (k.expires_at IS NULL OR k.expires_at>now()) AND o.hosting_mode='self_host'
      AND 'selfhost:bootstrap'=ANY(k.scopes) AND (k.revoked_at IS NULL OR k.revoked_reason='Memory Box enrollment consumed') LIMIT 1`, [sha256(raw)]);
  return rows[0] ? { ...rows[0], kind: 'bootstrap', replay: Boolean(rows[0].revoked_at), raw } : null;
}
async function connectionPrincipal(body) { return boxPrincipal(body.boxToken); }
async function upsertConnection({ orgId, endpoint, transport, tunnelId, credentialHash, metadata }, db = pool) {
  const { rows } = await db.query(`INSERT INTO memory_box_connections
    (org_id,box_id,transport,endpoint,credential_hash,state,tunnel_id,last_heartbeat_at,metadata)
    VALUES ($1,$2,$3,$4,$5,'REGISTERED',$6,now(),$7::jsonb)
    ON CONFLICT (org_id) DO UPDATE SET transport=EXCLUDED.transport,endpoint=EXCLUDED.endpoint,
      credential_hash=COALESCE(EXCLUDED.credential_hash,memory_box_connections.credential_hash),state='REGISTERED',
      tunnel_id=COALESCE(EXCLUDED.tunnel_id,memory_box_connections.tunnel_id),last_heartbeat_at=now(),
      metadata=memory_box_connections.metadata||EXCLUDED.metadata,revoked_at=NULL,updated_at=now()
    RETURNING org_id,box_id,transport,endpoint,state`,
  [orgId, crypto.randomUUID(), transport, endpoint, credentialHash || null, tunnelId || null, JSON.stringify(metadata || {})]);
  return rows[0];
}
async function projectConnection(orgId, { endpoint, agentToken, transport }) {
  let previous = null;
  await withRegistryLock(async (reg) => {
    previous = reg[orgId] ? structuredClone(reg[orgId]) : null;
    const revision = Number(reg[orgId]?.projectionRevision || 0) + 1;
    reg[orgId] = { ...(reg[orgId] || {}), url: endpoint, token: agentToken, kind: 'selfhost', transport, projectionRevision: revision };
  });
  return previous;
}
async function restoreConnectionProjection(orgId, previous) {
  await withRegistryLock(async (reg) => { if (previous) reg[orgId] = previous; else delete reg[orgId]; });
}

async function reconcileLegacyRegistry() {
  const registry = loadReg();
  for (const [orgId, entry] of Object.entries(registry)) {
    if (!entry || entry.kind === 'amr-central' || !(entry.url || entry.pgUrl || entry.qdrantUrl)) continue;
    try {
      const endpoint = entry.url ? String(entry.url).replace(/\/$/, '') : null;
      const transport = entry.transport || (!endpoint ? 'legacy_hybrid' : endpoint.includes('.ts.net') ? 'tailscale' : endpoint.includes('.singulancelabs.com') ? 'cloudflare' : 'custom_https');
      await pool.query(`INSERT INTO memory_box_connections
      (org_id,box_id,transport,endpoint,state,last_heartbeat_at,metadata)
      SELECT $1,$2,$3,$4,'IMPORTED_UNVERIFIED',NULL,'{"importedFromLegacyRegistry":true}'::jsonb
      WHERE EXISTS (SELECT 1 FROM organizations WHERE id=$1)
      ON CONFLICT (org_id) DO NOTHING`, [orgId, crypto.randomUUID(), transport, endpoint]);
    } catch (error) { console.warn(JSON.stringify({ event: 'memory_box.legacy_import_skipped', org_id: orgId, error: error.message })); }
  }
}

async function acquireOrgLock(client, orgId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const locked = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [`memory-box:${orgId}`]);
    if (locked.rows[0]?.acquired) return;
    await delay(100);
  }
  throw Object.assign(new Error('Memory Box enrollment is busy; retry shortly'), { statusCode: 409 });
}

let readinessCache = { expires: 0, value: null };
async function automaticReadiness() {
  if (readinessCache.expires > Date.now()) return readinessCache.value;
  let tunnel = false; let release = false;
  try { tunnel = await checkTunnelProvisioningReady(); } catch {}
  try {
    const manifest = process.env.MEMORY_BOX_STABLE_MANIFEST_URL || 'https://get.singulancelabs.com/memory-box/releases/stable/release.json';
    const response = await fetch(manifest, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
    const base = manifest.replace(/\/release\.json(?:\?.*)?$/, '');
    const publicKeyUrl = new URL('../../release.pub', manifest).toString();
    const [signature, publicKey] = await Promise.all([
      fetch(`${base}/release.sig`, { method: 'GET', signal: AbortSignal.timeout(3000) }),
      fetch(publicKeyUrl, { method: 'GET', signal: AbortSignal.timeout(3000) }),
    ]);
    if (response.ok && signature.ok && publicKey.ok) { const body = await response.json(); release = Boolean(body && typeof body === 'object'); }
  } catch {}
  readinessCache = { expires: Date.now() + 30_000, value: { ready: tunnel && release, tunnel, signedRelease: release } };
  return readinessCache.value;
}

await reconcileLegacyRegistry();
http.createServer(async (req, res) => {
  if (req.url === '/health') return send(res, 200, { ok: true, authority: 'memory-box-broker.v2' });
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
  try {
    const body = await readBody(req);
    if (req.url === '/v1/selfhost/readiness') {
      if (!isInternal(req)) return send(res, 401, { error: 'unauthorized' });
      const readiness = await automaticReadiness();
      return send(res, readiness.ready ? 200 : 503, readiness.ready ? readiness : { ...readiness, error: 'automatic Memory Box setup unavailable' });
    }
    if (req.url === '/v1/selfhost/enroll') {
      const principal = (await enrollmentPrincipal(body)) || (await connectorPrincipal(body));
      if (!principal) return send(res, 401, { error: 'invalid or expired enrollment credential' });
      if (principal.kind === 'connector') return send(res, 200, { ok: true, orgId: principal.org_id, credentialKind: principal.kind });
      if (body.transport && body.transport !== 'cloudflare') return send(res, 400, { error: 'bootstrap enrollment provisions the managed Cloudflare transport only' });
      const client = await pool.connect(); let tunnel;
      try {
        await acquireOrgLock(client, principal.org_id);
        const pending = await client.query(`SELECT endpoint,tunnel_id,state,metadata FROM memory_box_connections WHERE org_id=$1 AND revoked_at IS NULL`, [principal.org_id]);
        const meta = pending.rows[0]?.metadata || {};
        if (pending.rows[0]?.state === 'ENROLLING' && meta.enrollmentKeyId === principal.id && meta.connectorCredential) {
          tunnel = { agentUrl: pending.rows[0].endpoint, tunnelId: pending.rows[0].tunnel_id, connectorToken: unseal(meta.connectorCredential) };
        } else {
          tunnel = await provisionTunnel(principal.org_id);
          await client.query(`INSERT INTO memory_box_connections
            (org_id,box_id,transport,endpoint,state,tunnel_id,metadata)
            VALUES ($1,$2,'cloudflare',$3,'ENROLLING',$4,$5::jsonb)
            ON CONFLICT (org_id) DO UPDATE SET transport='cloudflare',endpoint=EXCLUDED.endpoint,state='ENROLLING',
              tunnel_id=EXCLUDED.tunnel_id,metadata=memory_box_connections.metadata||EXCLUDED.metadata,revoked_at=NULL,updated_at=now()`,
          [principal.org_id, crypto.randomUUID(), tunnel.agentUrl, tunnel.tunnelId,
            JSON.stringify({ enrollmentKeyId: principal.id, connectorCredential: seal(tunnel.connectorToken), enrollmentProvisionedAt: new Date().toISOString() })]);
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`memory-box:${principal.org_id}`]).catch(() => {}); client.release();
      }
      return send(res, 200, { ok: true, orgId: principal.org_id, credentialKind: principal.kind,
        agentUrl: tunnel.agentUrl, tunnelToken: tunnel.connectorToken, tunnelId: tunnel.tunnelId, transport: 'cloudflare' });
    }
    if (req.url === '/v1/selfhost/register' || req.url === '/v1/byod/enroll') {
      const principal = (await connectionPrincipal(body)) || (await registrationEnrollmentPrincipal(body)) || (await connectorPrincipal(body));
      if (!principal) return send(res, 401, { error: 'invalid or expired Memory Box credential' });
      const endpoint = String(body.agentUrl || body.instanceUrl || '').replace(/\/$/, '');
      const agentToken = String(body.agentToken || '');
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(agentToken)) return send(res, 400, { error: 'a strong URL-safe agentToken is required' });
      const durableToken = principal.kind === 'box' ? null : durableTokenForEnrollment(principal.raw);
      const transport = body.transport || (endpoint.includes('.singulancelabs.com') ? 'cloudflare' : endpoint.includes('.ts.net') ? 'tailscale' : 'custom_https');
      const client = await pool.connect(); let record; let previousProjection; let projected = false;
      try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT endpoint,tunnel_id,transport,metadata FROM memory_box_connections WHERE org_id=$1 FOR UPDATE`, [principal.org_id]);
        const expected = existing.rows[0];
        if (principal.kind === 'box' && expected && (endpoint !== expected.endpoint || transport !== expected.transport)) {
          await client.query('ROLLBACK'); return send(res, 409, { error: 'registered Memory Box credentials cannot change transport ownership' });
        }
        if (!await validateEndpoint(endpoint, transport, principal.org_id, transport === 'cloudflare' ? expected?.endpoint : null)) {
          await client.query('ROLLBACK'); return send(res, 400, { error: 'agentUrl is not valid for the selected transport' });
        }
        if (transport === 'cloudflare' && (!expected?.tunnel_id || (body.tunnelId && String(body.tunnelId) !== String(expected.tunnel_id)))) {
          await client.query('ROLLBACK'); return send(res, 409, { error: 'Cloudflare tunnel ownership does not match this enrollment' });
        }
        if (principal.replay && expected?.metadata?.agentTokenHash !== sha256(agentToken)) {
          await client.query('ROLLBACK'); return send(res, 409, { error: 'idempotent registration payload does not match the original registration' });
        }
        if (principal.kind === 'bootstrap') {
          const claimed = await client.query(`SELECT id,revoked_at,revoked_reason FROM api_keys WHERE id=$1 FOR UPDATE`, [principal.id]);
          const allowed = claimed.rows[0] && (!claimed.rows[0].revoked_at || claimed.rows[0].revoked_reason === 'Memory Box enrollment consumed');
          if (!allowed) { await client.query('ROLLBACK'); return send(res, 401, { error: 'enrollment credential already used' }); }
        }
        record = await upsertConnection({ orgId: principal.org_id, endpoint, transport, tunnelId: body.tunnelId,
          credentialHash: durableToken ? sha256(durableToken) : null, metadata: { projectionPending: true, agentTokenHash: sha256(agentToken) } }, client);
        previousProjection = await projectConnection(principal.org_id, { endpoint, agentToken, transport }); projected = true;
        if (principal.kind === 'bootstrap' && !principal.replay) await client.query(`UPDATE api_keys SET revoked_at=now(),revoked_reason='Memory Box enrollment consumed' WHERE id=$1`, [principal.id]);
        await client.query(`UPDATE memory_box_connections SET metadata=(metadata-'connectorCredential'-'enrollmentKeyId')||'{"projectionPending":false}'::jsonb WHERE org_id=$1`, [principal.org_id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (projected) await restoreConnectionProjection(principal.org_id, previousProjection).catch((restoreError) => {
          console.error(JSON.stringify({ event: 'memory_box.projection_restore_failed', org_id: principal.org_id, error: restoreError.message }));
        });
        throw error;
      } finally { client.release(); }
      console.log(JSON.stringify({ event: 'memory_box.registered', org_id: principal.org_id, box_id: record.box_id, transport }));
      return send(res, 200, { ok: true, orgId: principal.org_id, boxId: record.box_id, state: record.state, ...(durableToken ? { boxToken: durableToken } : {}) });
    }
    if (req.url === '/v1/selfhost/report' || req.url === '/v1/selfhost/heartbeat') {
      const principal = await connectionPrincipal(body); if (!principal) return send(res, 401, { error: 'invalid Memory Box credential' });
      const capabilities = Array.isArray(body.capabilities)
        ? [...new Set(body.capabilities.map((item) => String(item).trim()).filter((item) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(item)))].slice(0, 64) : null;
      const release = String(body.release || '').trim(); const protocol = String(body.protocol_version || '').trim();
      const schema = Number(body.schema_version);
      if (req.url.endsWith('/report') && (!/^[A-Za-z0-9._-]{1,120}$/.test(release)
        || !/^[A-Za-z0-9._-]{1,64}$/.test(protocol) || !Number.isInteger(schema) || schema < 1)) {
        return send(res, 400, { error: 'invalid Memory Box release report' });
      }
      const updated = await pool.query(`UPDATE memory_box_connections SET observed_release=COALESCE($2,observed_release),
        protocol_version=COALESCE($3,protocol_version),schema_version=COALESCE($4,schema_version),
        capabilities=COALESCE($5,capabilities),state='READY',last_heartbeat_at=now(),consecutive_failures=0,metadata=metadata||$6::jsonb,updated_at=now()
        WHERE org_id=$1 AND revoked_at IS NULL`, [principal.org_id, release || null,
        protocol || null, Number.isInteger(schema) && schema > 0 ? schema : null,
        capabilities, JSON.stringify({ rollbackAvailable: body.rollback_available === true, rollbackRelease: String(body.rollback_release || '').slice(0, 120) || null })]);
      if (updated.rowCount !== 1) return send(res, 409, { error: 'Memory Box is not registered' });
      return send(res, 200, { ok: true, orgId: principal.org_id });
    }
    if (req.url === '/v1/selfhost/status') {
      const principal = isInternal(req) && body.orgId ? { org_id: String(body.orgId) } : await connectionPrincipal(body);
      if (!principal) return send(res, 401, { error: 'unauthorized' });
      const { rows } = await pool.query(`SELECT org_id,box_id,transport,endpoint,state,desired_release,observed_release,
        protocol_version,schema_version,capabilities,last_heartbeat_at,last_reachable_at,consecutive_failures,registered_at
        FROM memory_box_connections WHERE org_id=$1 AND revoked_at IS NULL`, [principal.org_id]);
      if (!rows[0]) return send(res, 200, { registered: false, reachable: false, state: 'NEVER_REGISTERED' });
      const row = rows[0]; const reg = loadReg(); const token = reg[principal.org_id]?.token || '';
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 2500);
      const response = row.endpoint ? await fetch(`${row.endpoint}/health`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: controller.signal }).catch(() => null) : null; clearTimeout(timer);
      const reachable = Boolean(response?.ok);
      const failures = reachable ? 0 : Number(row.consecutive_failures || 0) + 1;
      const state = reachable ? 'READY' : failures >= 3 ? 'OFFLINE' : 'DEGRADED';
      await pool.query(`UPDATE memory_box_connections SET state=$2,consecutive_failures=$4,
        last_reachable_at=CASE WHEN $3 THEN now() ELSE last_reachable_at END,updated_at=now() WHERE org_id=$1`, [principal.org_id, state, reachable, failures]);
      return send(res, 200, { registered: true, reachable, orgId: row.org_id, boxId: row.box_id,
        transport: row.transport, endpoint: row.endpoint, state, desiredRelease: row.desired_release,
        observedRelease: row.observed_release, protocolVersion: row.protocol_version, schemaVersion: row.schema_version,
        capabilities: row.capabilities, lastHeartbeatAt: row.last_heartbeat_at, lastReachableAt: reachable ? new Date().toISOString() : row.last_reachable_at,
        consecutiveFailures: failures, registeredAt: row.registered_at });
    }
    if (req.url === '/v1/selfhost/rotate-agent-token') {
      if (!isInternal(req) || !body.orgId) return send(res, 401, { error: 'unauthorized' });
      const principal = { org_id: String(body.orgId) };
      const reg = loadReg(); const entry = reg[principal.org_id];
      if (!entry?.url || !entry?.token) return send(res, 409, { error: 'no agent registered for this organization' });
      const graceExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const previousTokens = (Array.isArray(entry.previousTokens) ? entry.previousTokens : [])
        .filter((item) => item?.token && new Date(item.expiresAt).getTime() > Date.now()).slice(-2);
      previousTokens.push({ token: entry.token, expiresAt: graceExpiresAt });
      const agentToken = crypto.randomBytes(32).toString('base64url');
      await withRegistryLock(async (current) => { current[principal.org_id] = { ...(current[principal.org_id] || entry), token: agentToken, previousTokens }; });
      return send(res, 200, { ok: true, agentToken, grace_expires_at: graceExpiresAt });
    }
    if (req.url === '/v1/byod/disenroll') {
      if (!isInternal(req) || !body.orgId) return send(res, 401, { error: 'unauthorized' });
      const principal = { org_id: String(body.orgId) };
      await pool.query(`UPDATE memory_box_connections SET state='REVOKED',revoked_at=now(),updated_at=now() WHERE org_id=$1`, [principal.org_id]);
      await withRegistryLock(async (reg) => { delete reg[principal.org_id]; }); return send(res, 200, { ok: true, orgId: principal.org_id });
    }
    return send(res, 404, { error: 'not found' });
  } catch (error) {
    console.error(JSON.stringify({ event: 'memory_box.broker_error', error: error.message }));
    return send(res, error.statusCode || 500, { error: error.message });
  }
}).listen(PORT, () => console.log(JSON.stringify({ event: 'memory_box.broker_ready', port: PORT })));

// hm-broker — runs on OUR side, next to the core. Accepts hm-agent enrollment: the customer's agent
// presents the org API key + its reachable endpoint; the broker validates the key against Postgres,
// resolves the orgId, and writes the agent into the shared registry file the core's remote-backend
// reads (MNEME_AGENT_REGISTRY_FILE). From then on the core routes that org's recall/write/edge to the
// agent (MNEME_MODE per-org = remote). No change to the core process — only the shared file.
//
// Env: DATABASE_URL, MNEME_AGENT_REGISTRY_FILE, BROKER_PORT (default 8790).
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import Pg from 'pg';

const PORT = Number(process.env.BROKER_PORT || 8790);
const REG = process.env.MNEME_AGENT_REGISTRY_FILE || die('MNEME_AGENT_REGISTRY_FILE required');
const pool = new Pg.Pool({ connectionString: process.env.DATABASE_URL || die('DATABASE_URL required'), max: 4 });

function die(m) { console.error(`[hm-broker] ${m}`); process.exit(1); }
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

function loadReg() { try { return existsSync(REG) ? JSON.parse(readFileSync(REG, 'utf8')) : {}; } catch { return {}; } }
function saveReg(o) { writeFileSync(REG, JSON.stringify(o), 'utf8'); }

// Validate an org API key → { orgId } or null. Matches sha256(key) against api_keys.key_hash.
async function resolveOrg(apiKey) {
  if (!apiKey) return null;
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const { rows } = await pool.query('SELECT org_id FROM api_keys WHERE key_hash = $1 AND (revoked_at IS NULL) LIMIT 1', [hash]);
  return rows[0]?.org_id || null;
}

http.createServer(async (req, res) => {
  if (req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
  const body = await readBody(req);
  try {
    if (req.url === '/v1/byod/enroll') {
      const orgId = await resolveOrg(body.apiKey);
      if (!orgId) return send(res, 401, { error: 'invalid api key' });
      if (!body.agentUrl || !body.agentToken) return send(res, 400, { error: 'agentUrl + agentToken required' });
      const reg = loadReg();
      reg[orgId] = { url: body.agentUrl.replace(/\/$/, ''), token: body.agentToken };
      saveReg(reg);
      console.log(`[hm-broker] enrolled org=${orgId} → ${body.agentUrl}`);
      return send(res, 200, { ok: true, orgId });
    }
    // Self-host model: the customer runs the FULL engine on their box. enroll = "validate my key, tell
    // me which org I am" (called at setup, before the stack is up). register = "my instance is live at
    // this URL" (so the central dashboard can reach/manage it).
    if (req.url === '/v1/selfhost/enroll') {
      const orgId = await resolveOrg(body.apiKey);
      if (!orgId) return send(res, 401, { error: 'invalid api key' });
      console.log(`[hm-broker] selfhost enroll org=${orgId}`);
      return send(res, 200, { ok: true, orgId });
    }
    if (req.url === '/v1/selfhost/register') {
      const orgId = await resolveOrg(body.apiKey);
      if (!orgId) return send(res, 401, { error: 'invalid api key' });
      if (!body.instanceUrl && !body.pgUrl) return send(res, 400, { error: 'instanceUrl or pgUrl required' });
      const reg = loadReg();
      reg[orgId] = {
        url: (body.instanceUrl || '').replace(/\/$/, ''),
        token: body.agentToken || '',
        pgUrl: body.pgUrl || '',          // full residency: the customer's Postgres (via their tunnel)
        qdrantUrl: body.qdrantUrl || '',  // and their Qdrant, if hosted on-box
        kind: 'selfhost',
      };
      saveReg(reg);
      console.log(`[hm-broker] selfhost register org=${orgId} → ${body.instanceUrl}`);
      return send(res, 200, { ok: true, orgId });
    }
    if (req.url === '/v1/byod/disenroll') {
      const orgId = await resolveOrg(body.apiKey);
      if (!orgId) return send(res, 401, { error: 'invalid api key' });
      const reg = loadReg(); delete reg[orgId]; saveReg(reg);
      return send(res, 200, { ok: true, orgId });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[hm-broker]', e.message);
    return send(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`[hm-broker] listening :${PORT} → registry ${REG}`));

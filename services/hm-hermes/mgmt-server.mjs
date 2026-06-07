#!/usr/bin/env node
/**
 * hm-hermes management server (Phase 6h) — the SECURE transport that replaces
 * "docker exec from hm-control".
 *
 * Runs INSIDE the hm-hermes container as an s6 longrun, alongside the gateway.
 * It owns profile lifecycle by invoking the LOCAL hermes CLI (/opt/hermes/bin/
 * hermes) as a child process and writing files under /opt/data/profiles — NO
 * docker, NO docker.sock anywhere. hm-control (which has neither docker nor
 * socket, and is public-facing) calls this over HTTP on the internal `hmtest`
 * network. The port is NEVER published to the host.
 *
 * AuthN: every request must carry `Authorization: Bearer ${HERMES_MGMT_KEY}`.
 * The key is injected via env (Coolify/docker -e), never committed. Requests
 * without it get 401. The server only ever runs FIXED hermes subcommands with
 * argument arrays (execFile, no shell) — no arbitrary command execution.
 *
 * @module hm-hermes/mgmt-server
 */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const exec = promisify(execFile);
const PORT = Number(process.env.HERMES_MGMT_PORT || 8650);
const HOST = process.env.HERMES_MGMT_HOST || '0.0.0.0';
const MGMT_KEY = process.env.HERMES_MGMT_KEY || '';
const HERMES_BIN = process.env.HERMES_BIN || '/opt/hermes/bin/hermes';
const PROFILES_DIR = process.env.HERMES_PROFILES_DIR || '/opt/data/profiles';

/** profile name for a tenant: org-<sanitized>. (Mirrors hm-control side.) */
function profileName(tenantId) {
  const s = String(tenantId || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `org-${s}`;
}

/** Run the local hermes CLI (no shell). */
async function hermes(args, { timeoutMs = 60000 } = {}) {
  try {
    const { stdout, stderr } = await exec(HERMES_BIN, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (err) {
    return { ok: false, stdout: (err.stdout || '').trim(), stderr: (err.stderr || err.message || '').trim() };
  }
}

async function writeProfileFile(tenantId, relpath, content) {
  // Reject path traversal — relpath must stay inside the profile dir.
  if (/\.\.(\/|\\|$)/.test(relpath) || relpath.startsWith('/')) {
    return { ok: false, error: 'invalid relpath' };
  }
  const full = `${PROFILES_DIR}/${profileName(tenantId)}/${relpath}`;
  try {
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Lifecycle ops (local hermes CLI) ────────────────────────────────

async function createProfile({ tenantId, apiKey, port, soul, extraEnv = {} }) {
  const profile = profileName(tenantId);
  if (!apiKey || !port) return { ok: false, profile, issues: ['apiKey + port required'] };
  const create = await hermes(['profile', 'create', profile]);
  // "already exists" is idempotent-OK. Hermes prints it to stdout (not stderr),
  // and execFile's err.message is just "Command failed" — so check BOTH streams.
  const existsAlready = /exist/i.test(create.stderr) || /exist/i.test(create.stdout);
  if (!create.ok && !existsAlready) return { ok: false, profile, issues: [`create: ${create.stderr || create.stdout}`] };
  const envLines = {
    API_SERVER_ENABLED: 'true', API_SERVER_HOST: '0.0.0.0', API_SERVER_PORT: String(port), API_SERVER_KEY: apiKey, ...extraEnv,
  };
  const envText = Object.entries(envLines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  const w = await writeProfileFile(tenantId, '.env', envText);
  if (!w.ok) return { ok: false, profile, issues: [`write .env: ${w.error}`] };
  if (soul) {
    const ws = await writeProfileFile(tenantId, 'SOUL.md', soul);
    if (!ws.ok) return { ok: false, profile, issues: [`write SOUL: ${ws.error}`] };
  }
  return { ok: true, profile, issues: [] };
}

async function gatewayAction(tenantId, action) {
  const r = await hermes(['-p', profileName(tenantId), 'gateway', action]);
  return { ok: r.ok, issues: r.ok ? [] : [r.stderr] };
}

async function getStatus(tenantId) {
  const profile = profileName(tenantId);
  const r = await hermes(['profile', 'list']);
  if (!r.ok) return { exists: false, gatewayRunning: false };
  const line = r.stdout.split('\n').find((l) => l.includes(profile));
  return { exists: !!line, gatewayRunning: !!line && /running/i.test(line) };
}

async function deleteProfile(tenantId) {
  const profile = profileName(tenantId);
  await hermes(['-p', profile, 'gateway', 'stop']);
  const r = await hermes(['profile', 'delete', profile, '-y']);
  return { ok: r.ok, issues: r.ok ? [] : [r.stderr] };
}

// ── HTTP plumbing ───────────────────────────────────────────────────

function send(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

function authed(req) {
  if (!MGMT_KEY) return false; // fail closed: no key configured = no access
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Bearer ')) return false;
  const given = Buffer.from(h.slice(7).trim());
  const want = Buffer.from(MGMT_KEY);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // Health check — unauthenticated, no side effects (s6/liveness probes).
  if (path === '/mgmt/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, service: 'hm-hermes-mgmt' });
  }

  if (!authed(req)) return send(res, 401, { ok: false, error: 'unauthorized' });

  try {
    if (req.method === 'GET' && path === '/mgmt/profile/status') {
      const tenantId = url.searchParams.get('tenantId');
      if (!tenantId) return send(res, 400, { ok: false, error: 'tenantId required' });
      return send(res, 200, { ok: true, ...(await getStatus(tenantId)) });
    }

    if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'not found' });
    const body = await readBody(req);
    const tenantId = body.tenantId;
    if (!tenantId && path !== '/mgmt/ping') return send(res, 400, { ok: false, error: 'tenantId required' });

    switch (path) {
      case '/mgmt/ping':
        return send(res, 200, { ok: true, pong: true });
      case '/mgmt/profile/create':
        return send(res, 200, await createProfile(body));
      case '/mgmt/profile/file': {
        const content = body.contentB64 ? Buffer.from(body.contentB64, 'base64').toString('utf8') : (body.content || '');
        return send(res, 200, await writeProfileFile(tenantId, body.relpath, content));
      }
      case '/mgmt/gateway/start':
        return send(res, 200, await gatewayAction(tenantId, 'start'));
      case '/mgmt/gateway/stop':
        return send(res, 200, await gatewayAction(tenantId, 'stop'));
      case '/mgmt/gateway/restart':
        return send(res, 200, await gatewayAction(tenantId, 'restart'));
      case '/mgmt/profile/delete':
        return send(res, 200, await deleteProfile(tenantId));
      default:
        return send(res, 404, { ok: false, error: 'not found' });
    }
  } catch (err) {
    return send(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console -- single boot line; this is a service entrypoint, not app code
  console.log(`[hm-hermes-mgmt] listening on ${HOST}:${PORT} (key ${MGMT_KEY ? 'set' : 'MISSING — fail-closed'})`);
});

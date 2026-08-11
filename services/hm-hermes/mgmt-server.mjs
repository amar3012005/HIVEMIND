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
import { mkdir, writeFile, readFile } from 'node:fs/promises';
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

/**
 * Merge key/value pairs into a tenant's profile .env without clobbering existing
 * keys that are NOT in the provided env object. Keys present in the env object
 * are upserted (added if absent, replaced if already there).
 *
 * Constraint: both key and value are ASCII-safe env var text; values may NOT
 * contain newlines (reject if they do — prevents injection into the .env file).
 *
 * @param {string} tenantId
 * @param {Record<string,string>} env
 * @returns {Promise<{ ok:boolean, error?:string }>}
 */
async function mergeProfileEnv(tenantId, env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { ok: false, error: 'env must be a non-array object' };
  }
  const entries = Object.entries(env);
  if (!entries.length) return { ok: true }; // nothing to do
  // Validate keys (must be valid env var names) and values (no newlines).
  for (const [k, v] of entries) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(k)) return { ok: false, error: `invalid env key: ${k}` };
    if (String(v).includes('\n') || String(v).includes('\r')) {
      return { ok: false, error: `value for ${k} contains a newline — rejected` };
    }
  }
  const full = `${PROFILES_DIR}/${profileName(tenantId)}/.env`;
  let existing = '';
  try {
    existing = await readFile(full, 'utf8');
  } catch {
    // File may not exist yet — treat as empty (createProfile will have written it
    // on first create; mergeProfileEnv is always called after that).
    existing = '';
  }
  // Parse current lines into a map (preserve comments/blanks as-is).
  const lines = existing.split('\n');
  /** @type {Map<string, number>} key → line index for existing KEY=… lines */
  const keyLineMap = new Map();
  const parsedLines = lines.map((line, i) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
    if (m) { keyLineMap.set(m[1], i); }
    return line;
  });
  // Upsert each incoming key.
  for (const [k, v] of entries) {
    const newLine = `${k}=${v}`;
    if (keyLineMap.has(k)) {
      parsedLines[keyLineMap.get(k)] = newLine;
    } else {
      parsedLines.push(newLine);
    }
  }
  // Ensure trailing newline, remove excess blank lines at the end.
  const merged = parsedLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  return writeProfileFile(tenantId, '.env', merged);
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

// ── Cron ops (local hermes CLI) ─────────────────────────────────────

/**
 * List cron jobs for a tenant's profile.
 * @returns {{ ok:boolean, jobs:object[], raw:string, issues:string[] }}
 */
async function cronList(tenantId) {
  const r = await hermes(['-p', profileName(tenantId), 'cron', 'list', '--all']);
  if (!r.ok) return { ok: false, jobs: [], raw: r.stderr, issues: [r.stderr || 'cron list failed'] };
  // Parse the tab/space-aligned table output. Each line that contains a hex id
  // (12 hex chars) represents one job. Fall back to returning raw text if
  // parsing yields nothing — the caller can use raw to build its own view.
  const lines = r.stdout.split('\n').filter(Boolean);
  const jobs = [];
  for (const line of lines) {
    // Format from recon: "  <id>  <name>  <schedule>  <status>  <next_run_at>"
    // The id is always 12 lowercase hex chars.
    const m = line.match(/^\s*([0-9a-f]{12})\s+(.+)$/i);
    if (m) jobs.push({ id: m[1], raw: line.trim() });
  }
  return { ok: true, jobs, raw: r.stdout, issues: [] };
}

/**
 * Add a cron job to a tenant's profile.
 * @param {string} tenantId
 * @param {{ cron:string, prompt?:string, name?:string, deliver?:string }} opts
 * @returns {{ ok:boolean, jobId:string|null, issues:string[] }}
 */
async function cronAdd(tenantId, { cron: schedule, prompt = '', name = '', deliver = 'origin' } = {}) {
  if (!schedule) return { ok: false, jobId: null, issues: ['schedule (cron expr or interval) required'] };
  const args = ['-p', profileName(tenantId), 'cron', 'create', schedule];
  if (prompt) args.push(prompt);
  if (name) { args.push('--name'); args.push(name); }
  if (deliver) { args.push('--deliver'); args.push(deliver); }
  const r = await hermes(args);
  if (!r.ok) return { ok: false, jobId: null, issues: [r.stderr || r.stdout || 'cron create failed'] };
  // Parse: "Created job: <12-hex-id>"
  const m = r.stdout.match(/Created job:\s*([0-9a-f]{12})/i);
  const jobId = m ? m[1] : null;
  return { ok: true, jobId, raw: r.stdout, issues: [] };
}

/**
 * Remove a cron job from a tenant's profile.
 * @param {string} tenantId
 * @param {string} jobId  12-hex cron job id
 * @returns {{ ok:boolean, issues:string[] }}
 */
async function cronDelete(tenantId, jobId) {
  if (!jobId) return { ok: false, issues: ['jobId required'] };
  const r = await hermes(['-p', profileName(tenantId), 'cron', 'remove', jobId]);
  if (!r.ok) return { ok: false, issues: [r.stderr || r.stdout || 'cron remove failed'] };
  return { ok: true, issues: [] };
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
      case '/mgmt/profile/env-merge': {
        const envMap = body.env && typeof body.env === 'object' ? body.env : null;
        if (!envMap) return send(res, 400, { ok: false, error: 'env object required' });
        return send(res, 200, await mergeProfileEnv(tenantId, envMap));
      }
      case '/mgmt/gateway/start':
        return send(res, 200, await gatewayAction(tenantId, 'start'));
      case '/mgmt/gateway/stop':
        return send(res, 200, await gatewayAction(tenantId, 'stop'));
      case '/mgmt/gateway/restart':
        return send(res, 200, await gatewayAction(tenantId, 'restart'));
      case '/mgmt/profile/delete':
        return send(res, 200, await deleteProfile(tenantId));
      case '/mgmt/cron/list':
        return send(res, 200, await cronList(tenantId));
      case '/mgmt/cron/add':
        return send(res, 200, await cronAdd(tenantId, body));
      case '/mgmt/cron/delete': {
        const jobId = body.jobId;
        if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
        return send(res, 200, await cronDelete(tenantId, jobId));
      }
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

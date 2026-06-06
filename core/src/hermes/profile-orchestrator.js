/**
 * Hermes per-tenant PROFILE orchestrator (Phase 6c).
 *
 * Profiles-per-tenant (NOT pods/K8s). One shared `hm-hermes` container hosts N
 * tenant profiles; each profile = its own SOUL/sessions/mcp + its own gateway on
 * a distinct API_SERVER_PORT, reachable cross-container at hm-hermes:<port>
 * (verified: no host port publish needed). This module wraps the Hermes CLI via
 * `docker exec <container> hermes [-p <profile>] …` (execFile — no shell).
 *
 * Lifecycle only (create/start/stop/restart/status/delete). The tenant→profile→
 * port registry + dispatch (runTask via hm-control-client) live in 6d. Dependency-
 * light on purpose (only node:child_process) so it runs wherever the Docker host
 * is. deleteProfile is data-preserving by intent (Hermes keeps the profile dir
 * until explicit delete; memory SoR is HiveMind anyway).
 *
 * @module hermes/profile-orchestrator
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CONTAINER = process.env.HERMES_CONTAINER || 'hm-hermes';

/** profile name for a tenant: org-<sanitized>. */
export function profileName(tenantId) {
  const s = String(tenantId).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `org-${s}`;
}

async function dx(args, { timeoutMs = 60000, input = null } = {}) {
  try {
    const opts = { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 };
    const { stdout, stderr } = await exec('docker', ['exec', ...(input ? ['-i'] : []), CONTAINER, ...args], opts);
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (err) {
    return { ok: false, stdout: (err.stdout || '').trim(), stderr: (err.stderr || err.message || '').trim() };
  }
}

/** Write a file inside the container (used for .env / SOUL.md). */
async function writeInContainer(path, content) {
  // base64 round-trip avoids quoting/heredoc hazards
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const r = await dx(['sh', '-c', `echo ${b64} | base64 -d > ${path}`]);
  return r.ok;
}

/**
 * Create a tenant profile + write its gateway .env (port/keys) and optional SOUL.
 * Does NOT start the gateway (call startGateway). mcp.json wiring = 6d.
 * @param {string} tenantId
 * @param {{ apiKey: string, port: number, soul?: string, extraEnv?: Record<string,string> }} cfg
 * @returns {Promise<{ ok:boolean, profile:string, port:number, issues:string[] }>}
 */
export async function createProfile(tenantId, { apiKey, port, soul = null, extraEnv = {} } = {}) {
  const profile = profileName(tenantId);
  if (!apiKey || !port) return { ok: false, profile, port, issues: ['apiKey + port required'] };
  const create = await dx(['hermes', 'profile', 'create', profile]);
  // "already exists" is fine (idempotent create)
  if (!create.ok && !/exist/i.test(create.stderr)) return { ok: false, profile, port, issues: [`create: ${create.stderr}`] };
  const envLines = {
    API_SERVER_ENABLED: 'true', API_SERVER_HOST: '0.0.0.0', API_SERVER_PORT: String(port), API_SERVER_KEY: apiKey, ...extraEnv,
  };
  const envText = Object.entries(envLines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  if (!await writeInContainer(`/opt/data/profiles/${profile}/.env`, envText)) return { ok: false, profile, port, issues: ['write .env failed'] };
  if (soul && !await writeInContainer(`/opt/data/profiles/${profile}/SOUL.md`, soul)) return { ok: false, profile, port, issues: ['write SOUL failed'] };
  return { ok: true, profile, port, issues: [] };
}

/** Write a file under a tenant's profile dir (e.g. 'config.yaml', 'mcp.json'). */
export async function writeProfileFile(tenantId, relpath, content) {
  return writeInContainer(`/opt/data/profiles/${profileName(tenantId)}/${relpath}`, content);
}

export async function startGateway(tenantId) { const r = await dx(['hermes', '-p', profileName(tenantId), 'gateway', 'start']); return { ok: r.ok, issues: r.ok ? [] : [r.stderr] }; }
export async function stopGateway(tenantId) { const r = await dx(['hermes', '-p', profileName(tenantId), 'gateway', 'stop']); return { ok: r.ok, issues: r.ok ? [] : [r.stderr] }; }
export async function restartGateway(tenantId) { const r = await dx(['hermes', '-p', profileName(tenantId), 'gateway', 'restart']); return { ok: r.ok, issues: r.ok ? [] : [r.stderr] }; }

/** @returns {Promise<{ exists:boolean, gatewayRunning:boolean }>} */
export async function getProfileStatus(tenantId) {
  const profile = profileName(tenantId);
  const r = await dx(['hermes', 'profile', 'list']);
  if (!r.ok) return { exists: false, gatewayRunning: false };
  const line = r.stdout.split('\n').find((l) => l.includes(profile));
  return { exists: !!line, gatewayRunning: !!line && /running/i.test(line) };
}

/** Stop gateway + delete the profile. Hermes prompts — pass -y. */
export async function deleteProfile(tenantId) {
  const profile = profileName(tenantId);
  await dx(['hermes', '-p', profile, 'gateway', 'stop']);
  const r = await dx(['hermes', 'profile', 'delete', profile, '-y']);
  return { ok: r.ok, issues: r.ok ? [] : [r.stderr] };
}

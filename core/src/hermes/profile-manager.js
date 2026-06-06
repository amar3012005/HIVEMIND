/**
 * hm-hermes-profile-manager (Phase 6d) — the Node module inside hm-control that
 * owns the tenant→profile mapping and dispatch. Profiles-per-tenant (NOT pods).
 *
 * - resolveRuntimeUrl(tenant) → http://hm-hermes:<port> (per-profile gateway port)
 * - ensureProfile(tenant)     → create profile (SOUL + config.yaml [model+MCP] +
 *                               .env port/key) + start its gateway + register
 * - runTask(tenant, payload)  → ensure + dispatch via hm-control-client.runOnce
 * - reconcile()               → registry vs live `hermes profile list`; drift=alert
 *
 * Reuses: profile-orchestrator (6c lifecycle), runtime-spec.deriveGatewayPort,
 * hm-control-client (runOnce/checkHealth — unchanged), hermes_runtimes registry
 * (6b, raw SQL like retrieval-config.js). MVP: shared master MCP key; per-tenant
 * scoped tokens are 6g. Creating a PROD tenant profile is the 6g human gate.
 *
 * @module hermes/profile-manager
 */
import { createProfile, startGateway, deleteProfile, getProfileStatus, writeProfileFile, profileName } from './profile-orchestrator.js';
import { deriveGatewayPort } from './runtime-spec.js';
import { runOnce, checkHealth } from './hm-control-client.js';

const HERMES_HOST = process.env.HERMES_HOST || 'hm-hermes';

/** Gateway URL for a tenant's profile (cross-container on the hivemind network). */
export function resolveRuntimeUrl(tenantId) {
  return `http://${HERMES_HOST}:${deriveGatewayPort(tenantId)}`;
}

/** Shared gateway API key (MVP). Per-tenant tokens = 6g. */
export function getApiKey() {
  return process.env.HERMES_API_SERVER_KEY || '';
}

/** Build the per-profile config.yaml (Groq model + HiveMind MCP).
 * NOTE: model.api_key MUST be the literal key — Hermes does NOT resolve env-refs
 * (${VAR}) for model.api_key (it does for MCP headers). The literal lands in the
 * profile's config.yaml on the root-only /opt/data volume (never git). */
function buildProfileConfigYaml(mcpUrl, groqKey) {
  return [
    'model:',
    '  default: openai/gpt-oss-20b',
    '  provider: custom',
    '  base_url: https://api.groq.com/openai/v1',
    `  api_key: ${groqKey}`,
    '  reasoning_effort: low',
    'mcp:',
    '  hivemind:',
    `    url: ${mcpUrl}`,
    '    headers:',
    '      Authorization: Bearer ${MCP_HIVEMIND_API_KEY}',
    '    enabled: true',
    '',
  ].join('\n');
}

async function upsertRegistry(prisma, { tenantId, profile, port, orgId, mcpUrl, status }) {
  if (!prisma) return;
  await prisma.$executeRawUnsafe(
    `INSERT INTO hivemind.hermes_runtimes
       (tenant_id, container_name, volume_name, gateway_port, networks, mcp_url, org_id, status, updated_at)
     VALUES ($1,$2,$3,$4,'{}',$5,$6,$7, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       container_name=$2, gateway_port=$4, mcp_url=$5, org_id=$6, status=$7, updated_at=now()`,
    tenantId, profile, profile, port, mcpUrl, orgId || tenantId, status,
  );
}

/**
 * Ensure a tenant's profile exists + its gateway is running. Idempotent.
 * @param {object} prisma  prisma client (registry)
 * @param {string} tenantId
 * @param {{ soul?: string, orgId?: string, mcpUrl?: string, mcpKey?: string }} [cfg]
 * @returns {Promise<{ ok:boolean, profile:string, port:number, url:string, issues:string[] }>}
 */
export async function ensureProfile(prisma, tenantId, cfg = {}) {
  const profile = profileName(tenantId);
  const port = deriveGatewayPort(tenantId);
  const url = resolveRuntimeUrl(tenantId);
  const apiKey = getApiKey();
  const mcpUrl = cfg.mcpUrl || (process.env.HIVEMIND_API_URL ? `${process.env.HIVEMIND_API_URL}/api/mcp` : 'https://core.hivemind.davinciai.eu:8050/api/mcp');
  if (!apiKey) return { ok: false, profile, port, url, issues: ['HERMES_API_SERVER_KEY missing'] };

  const st = await getProfileStatus(tenantId);
  if (st.exists && st.gatewayRunning) {
    await upsertRegistry(prisma, { tenantId, profile, port, orgId: cfg.orgId, mcpUrl, status: 'running' });
    return { ok: true, profile, port, url, issues: ['already running'] };
  }

  // MCP key for this profile (MVP: shared master key; per-tenant token = 6g)
  const mcpKey = cfg.mcpKey || process.env.MCP_HIVEMIND_API_KEY || apiKey;
  const create = await createProfile(tenantId, {
    apiKey, port,
    soul: cfg.soul || `You are the HiveMind agent runtime for tenant ${tenantId}. Use the hivemind MCP tools for all memory recall/search/save (system of record).`,
    extraEnv: { GROQ_API_KEY: process.env.GROQ_API_KEY || '', MCP_HIVEMIND_API_KEY: mcpKey },
  });
  if (!create.ok) return { ok: false, profile, port, url, issues: create.issues };
  await writeProfileFile(tenantId, 'config.yaml', buildProfileConfigYaml(mcpUrl, process.env.GROQ_API_KEY || ''));
  const s = await startGateway(tenantId);
  if (!s.ok) return { ok: false, profile, port, url, issues: ['startGateway: ' + s.issues.join(';')] };
  await upsertRegistry(prisma, { tenantId, profile, port, orgId: cfg.orgId, mcpUrl, status: 'running' });
  return { ok: true, profile, port, url, issues: [] };
}

/**
 * Dispatch a job to a tenant's profile (ensures it first).
 * @param {object} prisma
 * @param {string} tenantId
 * @param {object} agentConfig  HermesAgentConfig (validated by runOnce)
 * @param {{ task: string, context?: string }} payload
 * @returns {Promise<object>} runOnce result
 */
export async function runTask(prisma, tenantId, agentConfig, payload) {
  const ens = await ensureProfile(prisma, tenantId, { orgId: agentConfig?.tenant_id });
  if (!ens.ok) return { ok: false, status: 'failed', result: null, issues: ['ensureProfile: ' + ens.issues.join(';')] };
  return runOnce(agentConfig, payload, { baseUrl: ens.url, apiKey: getApiKey() });
}

/** Reconcile registry vs live profiles. Drift → report only (no auto-recreate). */
export async function reconcile(prisma) {
  if (!prisma) return { drift: [] };
  const rows = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, container_name, gateway_port, status FROM hivemind.hermes_runtimes WHERE deleted_at IS NULL`,
  ).catch(() => []);
  const drift = [];
  for (const r of rows) {
    const st = await getProfileStatus(r.tenant_id);
    if (!st.exists) drift.push({ tenant_id: r.tenant_id, issue: 'registry-says-exists-but-profile-absent' });
    else if (!st.gatewayRunning && r.status === 'running') drift.push({ tenant_id: r.tenant_id, issue: 'gateway-down' });
  }
  return { drift };
}

/** Tear down a tenant profile + registry row (volume/profile dir retained by Hermes). */
export async function destroyProfile(prisma, tenantId) {
  const d = await deleteProfile(tenantId);
  if (prisma) await prisma.$executeRawUnsafe(`UPDATE hivemind.hermes_runtimes SET status='deleted', deleted_at=now() WHERE tenant_id=$1`, tenantId).catch(() => {});
  return d;
}

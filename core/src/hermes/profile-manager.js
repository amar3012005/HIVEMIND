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
import { createProfile, startGateway, deleteProfile, getProfileStatus, writeProfileFile, profileName, buildConfigYaml } from './profile-orchestrator.js';
import { deriveGatewayPort } from './runtime-spec.js';
import { runOnce, checkHealth } from './hm-control-client.js';
import { createPersistedApiKey } from '../auth/api-keys.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HERMES_HOST = process.env.HERMES_HOST || 'hm-hermes';

/** Gateway URL for a tenant's profile (cross-container on the hivemind network). */
export function resolveRuntimeUrl(tenantId) {
  return `http://${HERMES_HOST}:${deriveGatewayPort(tenantId)}`;
}

/** Shared gateway API key (MVP). Per-tenant tokens = 6g. */
export function getApiKey() {
  return process.env.HERMES_API_SERVER_KEY || '';
}

/**
 * Poll a freshly-started gateway until its HTTP port is bound. The Hermes gateway
 * returns from `gateway start` immediately, but the Python API server takes a few
 * seconds to bind — dispatching before that yields ECONNREFUSED ("fetch failed").
 * ANY HTTP response (incl. 401/404) proves the port is live; only a connection
 * error retries. Bounded so a wedged gateway can't hang the request.
 * @returns {Promise<boolean>} true once reachable, false on timeout.
 */
async function waitForGateway(url, { timeoutMs = 20000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      try {
        await fetch(url, { signal: ctrl.signal });
        return true; // any status = port bound
      } finally {
        clearTimeout(t);
      }
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return false;
}

/** Build the per-profile config.yaml. Default = Groq llama-3.3-70b-versatile
 * (non-reasoning, tool-capable — gpt-oss-20b's reasoning_content breaks multi-turn
 * tool calls on Groq). Per-profile model is overridable via PUT /hermes/agent/model.
 * Delegates to the shared buildConfigYaml in profile-orchestrator. */
function buildProfileConfigYaml(mcpUrl, groqKey) {
  return buildConfigYaml({
    provider: 'groq',
    model: process.env.HERMES_MODEL || 'llama-3.3-70b-versatile',
    apiKeyLiteral: groqKey,
    mcpUrl,
    browserMcpUrl: process.env.HERMES_BROWSER_MCP_URL || 'http://hivemind-control-plane:3000/hermes/mcp/browser',
    webMcpUrl: process.env.HERMES_PLAYWRIGHT_MCP_URL || 'http://hm-playwright:8931/mcp',
  });
}

async function upsertRegistry(prisma, { tenantId, profile, port, orgId, mcpUrl, status, mcpKeyId = null, mcpKeyPrefix = null }) {
  if (!prisma) return;
  await prisma.$executeRawUnsafe(
    `INSERT INTO hivemind.hermes_runtimes
       (tenant_id, container_name, volume_name, gateway_port, networks, mcp_url, org_id, status, mcp_key_id, mcp_key_prefix, updated_at)
     VALUES ($1,$2,$3,$4,'{}',$5,$6,$7,$8,$9, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       container_name=$2, gateway_port=$4, mcp_url=$5, org_id=$6, status=$7,
       mcp_key_id=COALESCE($8, hivemind.hermes_runtimes.mcp_key_id),
       mcp_key_prefix=COALESCE($9, hivemind.hermes_runtimes.mcp_key_prefix),
       updated_at=now()`,
    tenantId, profile, profile, port, mcpUrl, orgId || tenantId, status, mcpKeyId, mcpKeyPrefix,
  );
}

/**
 * Mint a HiveMind API key scoped to ONE org for that tenant's profile MCP, so a
 * compromised profile can't reach other orgs' memory. Returns the existing key's
 * id if already minted (raw is not re-derivable — caller falls back to master on
 * first-create only). On any failure (no prisma, non-uuid tenant, mint error)
 * returns null and the caller uses the shared master key (back-compat).
 * @returns {Promise<{ rawKey:string, keyId:string, keyPrefix:string }|null>}
 */
async function mintScopedMcpKey(prisma, { tenantId, orgId, userId }) {
  if (!prisma || !userId) return null;
  const org = orgId || tenantId;
  if (!UUID_RE.test(String(org))) return null; // apiKey.orgId is a uuid column
  try {
    const { rawKey, record } = await createPersistedApiKey(prisma, {
      userId,
      orgId: org,
      name: `Hermes profile ${profileName(tenantId)}`,
      description: 'Per-tenant scoped MCP key for the Hermes agent runtime (auto-minted).',
      scopes: ['memory:read', 'memory:write', 'mcp'],
    });
    return { rawKey, keyId: record.id, keyPrefix: record.keyPrefix };
  } catch {
    return null;
  }
}

/**
 * Ensure a tenant's profile exists + its gateway is running. Idempotent.
 * @param {object} prisma  prisma client (registry)
 * @param {string} tenantId
 * @param {{ soul?: string, orgId?: string, mcpUrl?: string, mcpKey?: string, mcpUserId?: string }} [cfg]
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

  // Per-tenant scoped MCP key (preferred): isolates this profile to one org's
  // memory. Falls back to the shared master key when minting isn't possible
  // (no prisma/userId, or a non-uuid throwaway tenant) — back-compatible.
  const scoped = cfg.mcpKey ? null : await mintScopedMcpKey(prisma, { tenantId, orgId: cfg.orgId, userId: cfg.mcpUserId });
  const mcpKey = cfg.mcpKey || scoped?.rawKey || process.env.MCP_HIVEMIND_API_KEY || apiKey;
  const create = await createProfile(tenantId, {
    apiKey, port,
    soul: cfg.soul || `You are the HiveMind agent runtime for tenant ${tenantId}. Use the hivemind MCP tools for all memory recall/search/save (system of record). For web tasks you have TWO browser tool sets: prefer the Playwright "browser_*" tools (a server-side headless browser) for public web — research, reading pages, extracting data, filling public forms; use the WebBridge tools only when the task needs the user's own logged-in browser sessions (their email, internal apps). Only call a tool that is actually listed in your available tools.`,
    extraEnv: { GROQ_API_KEY: process.env.GROQ_API_KEY || '', MCP_HIVEMIND_API_KEY: mcpKey },
  });
  if (!create.ok) return { ok: false, profile, port, url, issues: create.issues };
  await writeProfileFile(tenantId, 'config.yaml', buildProfileConfigYaml(mcpUrl, process.env.GROQ_API_KEY || ''));
  const s = await startGateway(tenantId);
  if (!s.ok) return { ok: false, profile, port, url, issues: ['startGateway: ' + s.issues.join(';')] };
  const ready = await waitForGateway(url);
  await upsertRegistry(prisma, {
    tenantId, profile, port, orgId: cfg.orgId, mcpUrl, status: ready ? 'running' : 'starting',
    mcpKeyId: scoped?.keyId || null, mcpKeyPrefix: scoped?.keyPrefix || null,
  });
  if (!ready) return { ok: false, profile, port, url, issues: ['gateway did not become reachable within timeout'] };
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
export async function runTask(prisma, tenantId, agentConfig, payload, opts = {}) {
  const ens = await ensureProfile(prisma, tenantId, { orgId: agentConfig?.tenant_id || tenantId, mcpUserId: opts.createdBy });
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

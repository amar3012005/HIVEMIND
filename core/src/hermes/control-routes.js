/**
 * Phase 6e — hm-control `/hermes/*` route handler (tenant-scoped Hermes agents).
 *
 * Mounted in control-plane-server.js (NEVER server.js) as a single delegating call
 * just before the 404 fallthrough. Self-contained so the server diff stays one line.
 *
 * EVERY request is:
 *   1. flag-gated  — HERMES_MANAGER_ENABLED !== 'true' → 404 (prod behavior unchanged).
 *   2. session-auth — via injected requireSession.
 *   3. org-scoped   — list/create scoped to session.orgId; every :id route asserts
 *                     the agent row's org_id === session.orgId else 403 (no cross-org).
 *
 * Persistence: hivemind.hermes_agents (roster/config) + hivemind.hermes_jobs (append-only
 * audit) via raw SQL (same approach as hermes_runtimes — no schema.prisma drift).
 * Dispatch/lifecycle delegate to profile-manager (ensureProfile/runTask/destroyProfile).
 *
 * tenant == org: a tenant's profile id is its org_id (1 profile = 1 org).
 *
 * @module hermes/control-routes
 */
import crypto from 'node:crypto';
// profile-manager (→ runtime-spec → ajv) is lazy-imported only on dispatch so the
// default-OFF path (and server boot) never loads it. See run branch below.
// library is a static module with no heavy deps — imported at top level.
import { LIBRARY, findTemplate } from './library.js';

const ROUTE_PREFIX = '/hermes/';

function isEnabled() {
  return process.env.HERMES_MANAGER_ENABLED === 'true';
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Load one agent row scoped to org. Returns null if absent OR not owned by org. */
async function loadOwnedAgent(prisma, orgId, agentId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, org_id, tenant_id, name, config, status
       FROM hivemind.hermes_agents
      WHERE id = $1 AND deleted_at IS NULL`,
    agentId,
  ).catch(() => []);
  const row = rows && rows[0];
  if (!row) return { row: null, forbidden: false };
  if (row.org_id !== orgId) return { row: null, forbidden: true };
  return { row, forbidden: false };
}

async function auditJob(prisma, { orgId, tenantId, agentId, action, status, payload, result, createdBy }) {
  const id = newId('hjob');
  await prisma.$executeRawUnsafe(
    `INSERT INTO hivemind.hermes_jobs
       (id, org_id, tenant_id, agent_id, action, status, payload, result, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
    id, orgId, tenantId, agentId, action, status,
    JSON.stringify(payload || null), JSON.stringify(result || null), createdBy || null,
  ).catch(() => {});
  return id;
}

/**
 * Handle a `/hermes/*` request. Returns true if it owned the response, false to fall through.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ pathname:string, method:string, prisma:object,
 *           jsonResponse:Function, parseBody:Function, requireSession:Function }} ctx
 * @returns {Promise<boolean>}
 */
export async function handleHermesRoutes(req, res, ctx) {
  const { pathname, method, prisma, jsonResponse, parseBody, requireSession } = ctx;
  if (!pathname.startsWith(ROUTE_PREFIX)) return false;

  // (1) Flag gate — default OFF → indistinguishable from a non-existent route.
  if (!isEnabled()) {
    jsonResponse(res, { error: 'Not found' }, 404);
    return true;
  }
  if (!prisma) {
    jsonResponse(res, { error: 'Database unavailable' }, 503);
    return true;
  }

  // (2) Session auth.
  const current = await requireSession(req, res);
  if (!current) return true;
  const userId = current.session.userId;
  const orgId = current.session.orgId;
  if (!orgId) {
    jsonResponse(res, { error: 'No active organization' }, 400);
    return true;
  }
  const tenantId = orgId; // tenant == org

  try {
    // ── Collection: GET /hermes/agents ──────────────────────────────
    if (pathname === '/hermes/agents' && method === 'GET') {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, org_id, tenant_id, name, config, status, created_at, updated_at
           FROM hivemind.hermes_agents
          WHERE org_id = $1 AND deleted_at IS NULL
          ORDER BY created_at ASC`,
        orgId,
      );
      jsonResponse(res, { agents: rows });
      return true;
    }

    // ── Collection: POST /hermes/agents ─────────────────────────────
    if (pathname === '/hermes/agents' && method === 'POST') {
      const body = (await parseBody(req)) || {};
      const name = String(body.name || '').trim();
      if (!name) { jsonResponse(res, { error: 'name required' }, 400); return true; }
      const id = newId('hagent');
      const config = body.config && typeof body.config === 'object' ? body.config : {};
      await prisma.$executeRawUnsafe(
        `INSERT INTO hivemind.hermes_agents (id, org_id, tenant_id, name, config, status, created_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,'active',$6)`,
        id, orgId, tenantId, name, JSON.stringify(config), userId,
      );
      jsonResponse(res, { id, org_id: orgId, tenant_id: tenantId, name, config, status: 'active' }, 201);
      return true;
    }

    // ── :id routes ──────────────────────────────────────────────────
    // /hermes/agents/:id
    const detail = pathname.match(/^\/hermes\/agents\/([^/]+)$/);
    if (detail && method === 'PATCH') {
      const agentId = detail[1];
      const { row, forbidden } = await loadOwnedAgent(prisma, orgId, agentId);
      if (forbidden) { jsonResponse(res, { error: 'Forbidden' }, 403); return true; }
      if (!row) { jsonResponse(res, { error: 'Agent not found' }, 404); return true; }
      const body = (await parseBody(req)) || {};
      const nextName = body.name != null ? String(body.name) : row.name;
      const nextConfig = body.config && typeof body.config === 'object' ? body.config : row.config;
      await prisma.$executeRawUnsafe(
        `UPDATE hivemind.hermes_agents
            SET name=$2, config=$3::jsonb, updated_at=now()
          WHERE id=$1`,
        agentId, nextName, JSON.stringify(nextConfig),
      );
      jsonResponse(res, { id: agentId, name: nextName, config: nextConfig, status: row.status });
      return true;
    }

    // POST /hermes/agents/:id/run | /pause | /resume
    const action = pathname.match(/^\/hermes\/agents\/([^/]+)\/(run|pause|resume)$/);
    if (action && method === 'POST') {
      const agentId = action[1];
      const verb = action[2];
      const { row, forbidden } = await loadOwnedAgent(prisma, orgId, agentId);
      if (forbidden) { jsonResponse(res, { error: 'Forbidden' }, 403); return true; }
      if (!row) { jsonResponse(res, { error: 'Agent not found' }, 404); return true; }

      if (verb === 'pause' || verb === 'resume') {
        const status = verb === 'pause' ? 'paused' : 'active';
        await prisma.$executeRawUnsafe(
          `UPDATE hivemind.hermes_agents SET status=$2, updated_at=now() WHERE id=$1`,
          agentId, status,
        );
        await auditJob(prisma, { orgId, tenantId, agentId, action: verb, status: 'succeeded', createdBy: userId });
        jsonResponse(res, { id: agentId, status });
        return true;
      }

      // run
      if (row.status === 'paused') { jsonResponse(res, { error: 'Agent is paused' }, 409); return true; }
      const body = (await parseBody(req)) || {};
      const payload = { task: String(body.task || ''), context: body.context || '' };
      if (!payload.task) { jsonResponse(res, { error: 'task required' }, 400); return true; }
      const jobId = await auditJob(prisma, { orgId, tenantId, agentId, action: 'run', status: 'running', payload, createdBy: userId });
      // Build a normalized HermesAgentConfig so the strict AJV validator passes even
      // when the stored row.config is empty (agents created with minimal config).
      // agent_id MUST be a real UUID (the hagent_ row.id is NOT a UUID format).
      // hermes_profile convention: "org-<tenantId>" (matches profile-orchestrator.profileName).
      const storedCfg = (row.config && typeof row.config === 'object') ? row.config : {};
      const agentConfig = {
        // Defaults first — stored fields override below via spread.
        agent_id: crypto.randomUUID(),
        name: row.name,
        tenant_id: tenantId,
        hermes_profile: `org-${tenantId}`,
        memory_mode: 'hivemind_mcp',
        capabilities: Array.isArray(storedCfg.capabilities) ? storedCfg.capabilities : [],
        schedule: storedCfg.schedule && typeof storedCfg.schedule === 'object'
          ? storedCfg.schedule
          : { type: 'manual' },
        output_routes: Array.isArray(storedCfg.output_routes) && storedCfg.output_routes.length > 0
          ? storedCfg.output_routes
          : [{ type: 'hivemind_memory', tenant_id: tenantId }],
        safety_policy: storedCfg.safety_policy && typeof storedCfg.safety_policy === 'object'
          ? storedCfg.safety_policy
          : { max_tokens_per_run: 100000, max_runtime_seconds: 600 },
        status: row.status || 'active',
        // Spread stored config last so any explicitly-set fields override the defaults.
        ...storedCfg,
        // Re-assert non-negotiables that must not be overridden by empty stored values.
        tenant_id: tenantId,
        memory_mode: 'hivemind_mcp',
      };
      const { runTask } = await import('./profile-manager.js'); // lazy: pulls ajv only on dispatch
      const out = await runTask(prisma, tenantId, agentConfig, payload, { createdBy: userId });
      const status = out && out.ok ? 'succeeded' : 'failed';
      await prisma.$executeRawUnsafe(
        `UPDATE hivemind.hermes_jobs SET status=$2, result=$3::jsonb, updated_at=now() WHERE id=$1`,
        jobId, status, JSON.stringify(out || null),
      ).catch(() => {});
      jsonResponse(res, { job_id: jobId, status, result: out }, status === 'succeeded' ? 200 : 502);
      return true;
    }

    // GET /hermes/agents/:id/runs | /logs
    const listJobs = pathname.match(/^\/hermes\/agents\/([^/]+)\/(runs|logs)$/);
    if (listJobs && method === 'GET') {
      const agentId = listJobs[1];
      const { row, forbidden } = await loadOwnedAgent(prisma, orgId, agentId);
      if (forbidden) { jsonResponse(res, { error: 'Forbidden' }, 403); return true; }
      if (!row) { jsonResponse(res, { error: 'Agent not found' }, 404); return true; }
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, action, status, payload, result, created_at, updated_at
           FROM hivemind.hermes_jobs
          WHERE agent_id = $1 AND org_id = $2
          ORDER BY created_at DESC
          LIMIT 100`,
        agentId, orgId,
      );
      jsonResponse(res, { runs: rows });
      return true;
    }

    // GET /hermes/agents/:id/approvals
    const approvalsList = pathname.match(/^\/hermes\/agents\/([^/]+)\/approvals$/);
    if (approvalsList && method === 'GET') {
      const agentId = approvalsList[1];
      const { row, forbidden } = await loadOwnedAgent(prisma, orgId, agentId);
      if (forbidden) { jsonResponse(res, { error: 'Forbidden' }, 403); return true; }
      if (!row) { jsonResponse(res, { error: 'Agent not found' }, 404); return true; }
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, action, status, payload, created_at
           FROM hivemind.hermes_jobs
          WHERE agent_id = $1 AND org_id = $2 AND status = 'awaiting_approval'
          ORDER BY created_at DESC`,
        agentId, orgId,
      );
      jsonResponse(res, { approvals: rows });
      return true;
    }

    // POST /hermes/agents/:id/approvals/:aid  { decision: 'approve'|'reject' }
    const approvalAct = pathname.match(/^\/hermes\/agents\/([^/]+)\/approvals\/([^/]+)$/);
    if (approvalAct && method === 'POST') {
      const agentId = approvalAct[1];
      const approvalId = approvalAct[2];
      const { row, forbidden } = await loadOwnedAgent(prisma, orgId, agentId);
      if (forbidden) { jsonResponse(res, { error: 'Forbidden' }, 403); return true; }
      if (!row) { jsonResponse(res, { error: 'Agent not found' }, 404); return true; }
      const body = (await parseBody(req)) || {};
      const decision = body.decision === 'approve' ? 'approved' : 'rejected';
      // Org-scoped + agent-scoped update — cannot touch another org's approval row.
      const n = await prisma.$executeRawUnsafe(
        `UPDATE hivemind.hermes_jobs
            SET status=$4, updated_at=now()
          WHERE id=$1 AND agent_id=$2 AND org_id=$3 AND status='awaiting_approval'`,
        approvalId, agentId, orgId, decision,
      ).catch(() => 0);
      if (!n) { jsonResponse(res, { error: 'Approval not found' }, 404); return true; }
      jsonResponse(res, { id: approvalId, status: decision });
      return true;
    }

    // ── GET /hermes/agent — singleton canonical agent for the org ───────
    // Resolve-or-create: if an active hermes_agents row exists for this org,
    // return it; otherwise create one (name 'Hermes Agent') and return it.
    if (pathname === '/hermes/agent' && method === 'GET') {
      const existing = await prisma.$queryRawUnsafe(
        `SELECT id, org_id, tenant_id, name, config, status, created_at, updated_at
           FROM hivemind.hermes_agents
          WHERE org_id = $1 AND deleted_at IS NULL AND status != 'deleted'
          ORDER BY created_at ASC
          LIMIT 1`,
        orgId,
      );
      if (existing && existing.length > 0) {
        jsonResponse(res, { agent: existing[0] });
        return true;
      }
      // No active agent — create the canonical singleton.
      const id = newId('hagent');
      const name = 'Hermes Agent';
      const config = {};
      await prisma.$executeRawUnsafe(
        `INSERT INTO hivemind.hermes_agents (id, org_id, tenant_id, name, config, status, created_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,'active',$6)`,
        id, orgId, tenantId, name, JSON.stringify(config), userId,
      );
      jsonResponse(res, { agent: { id, org_id: orgId, tenant_id: tenantId, name, config, status: 'active' } }, 201);
      return true;
    }

    // ── GET /hermes/library — curated dispatch templates ────────────────
    if (pathname === '/hermes/library' && method === 'GET') {
      const items = LIBRARY.map(({ id, name, blurb, persona, suggestedTask, skills }) => ({
        id, name, blurb, persona, suggestedTask, skills,
      }));
      jsonResponse(res, { templates: items });
      return true;
    }

    // ── POST /hermes/library/:id/run — ephemeral template dispatch ───────
    const libraryRun = pathname.match(/^\/hermes\/library\/([^/]+)\/run$/);
    if (libraryRun && method === 'POST') {
      const templateId = libraryRun[1];
      const template = findTemplate(templateId);
      if (!template) { jsonResponse(res, { error: 'Template not found' }, 404); return true; }

      const body = (await parseBody(req)) || {};
      const task = String(body.task || template.suggestedTask || '').trim();
      const context = body.context || '';

      // Build a full, schema-valid HermesAgentConfig for this ephemeral run.
      const templateCfg = template.agentConfig;
      const ephemeralConfig = {
        agent_id: crypto.randomUUID(),
        name: template.name,
        tenant_id: tenantId,
        hermes_profile: `org-${tenantId}`,
        memory_mode: 'hivemind_mcp',
        capabilities: Array.isArray(templateCfg.capabilities) ? templateCfg.capabilities : [],
        schedule: templateCfg.schedule || { type: 'manual' },
        output_routes: Array.isArray(templateCfg.output_routes) && templateCfg.output_routes.length > 0
          ? templateCfg.output_routes
          : [{ type: 'hivemind_memory', tenant_id: tenantId }],
        safety_policy: templateCfg.safety_policy || { max_tokens_per_run: 100000, max_runtime_seconds: 600 },
        status: 'active',
        ...templateCfg,
        // Re-assert non-negotiables.
        agent_id: crypto.randomUUID(),
        tenant_id: tenantId,
        memory_mode: 'hivemind_mcp',
        // Ensure output_routes always has the tenant-scoped hivemind_memory route.
        output_routes: Array.isArray(templateCfg.output_routes) && templateCfg.output_routes.length > 0
          ? templateCfg.output_routes
          : [{ type: 'hivemind_memory', tenant_id: tenantId }],
      };

      const jobId = await auditJob(prisma, {
        orgId, tenantId, agentId: `lib:${templateId}`, action: 'library_run',
        status: 'running', payload: { templateId, task, context }, createdBy: userId,
      });
      const { runTask } = await import('./profile-manager.js');
      const out = await runTask(prisma, tenantId, ephemeralConfig, { task, context }, { createdBy: userId });
      const status = out && out.ok ? 'succeeded' : 'failed';
      await prisma.$executeRawUnsafe(
        `UPDATE hivemind.hermes_jobs SET status=$2, result=$3::jsonb, updated_at=now() WHERE id=$1`,
        jobId, status, JSON.stringify(out || null),
      ).catch(() => {});
      jsonResponse(res, { job_id: jobId, status, result: out }, status === 'succeeded' ? 200 : 502);
      return true;
    }

    // Unknown /hermes/* path.
    jsonResponse(res, { error: 'Not found' }, 404);
    return true;
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
    return true;
  }
}

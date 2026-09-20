/**
 * Internal HIVE-MIND capability endpoints for the agent runtime.
 *
 * These are the hm-core side of the `extra_agent_tools` contract in
 * `deploy/hm-agent-runtime-v2/extra_agent_tools.py`. Each tool is a thin typed
 * wrapper over exactly one endpoint here, and each endpoint here is a thin
 * adapter over a service hm-core already owns.
 *
 * Why this module exists at all:
 *
 * The runtime is a *separate service* with its own process, its own network
 * namespace, and no database credentials. It cannot call `handleRecallRoute`
 * or `prisma.memory.create` directly. It reaches hm-core over HTTP with the
 * internal key plus the resolved principal, and hm-core decides what that
 * principal may see. That is the whole point: **hm-core stays the tenancy and
 * permission authority.** A tool that scoped data itself would be a second,
 * weaker authority that drifts from the first.
 *
 * Two rules every handler here follows:
 *
 * 1. **The principal comes from the request, never from the body.** The runtime
 *    sends `X-HM-User-Id` / `X-HM-Org-Id`; the body carries only the payload.
 *    A body-supplied `user_id` would let a compromised runtime read any tenant.
 *
 * 2. **No fabricated success.** A handler that cannot reach its backing service
 *    returns a non-2xx with the reason. The tool layer turns that into a
 *    `ToolResultState.ERROR` chunk the model can see. A plausible-looking empty
 *    200 is the one response shape that makes an agent build on nothing.
 */

import { internalFetch } from '../internal/internal-fetch.js';

// The runtime's tool calls are on the agent's critical path. A hung backing
// service must surface as a tool error, not as a stalled run.
const BACKING_TIMEOUT_MS = Number(process.env.HM_INTERNAL_TOOL_TIMEOUT_MS || 60_000);

/**
 * Resolve the caller's principal from the internal-auth headers.
 *
 * The internal key already proved the caller is a trusted service; these
 * headers say *which* principal that service is acting for.
 *
 * `X-HM-Org-Id` is OPTIONAL, and that is deliberate. AgentScope's
 * `AgentToolFactory` signature is `(user_id, agent_id, session_id)` — it has no
 * org parameter, so the runtime genuinely does not know the org and cannot be
 * made to. Rather than have the runtime guess (an env-var default would be
 * wrong for every tenant but one), hm-core resolves the org from the user,
 * because hm-core is the tenancy authority and the user→org mapping is its
 * data. A caller that DOES know the org may send it; it is then verified
 * against membership rather than trusted.
 */
function unwrapTenancyKey(raw) {
  const value = String(raw || '').trim();
  const wrapped = value.match(/^org:([0-9a-f-]{36}):user:([0-9a-f-]{36})$/i);
  if (wrapped) return { orgId: wrapped[1], userId: wrapped[2] };
  return { userId: value, orgId: null };
}

async function resolvePrincipal(req, prisma) {
  const parsed = unwrapTenancyKey(req.headers['x-hm-user-id']);
  const userId = parsed.userId;
  const headerOrgId = String(req.headers['x-hm-org-id'] || parsed.orgId || '').trim();
  if (!UUID_RE.test(userId)) return { userId, orgId: null, error: 'invalid_user' };

  if (UUID_RE.test(headerOrgId)) {
    // A named org must be one the user actually belongs to. Trusting the header
    // would let a compromised runtime read any tenant by naming it.
    const membership = await prisma.userOrganization.findFirst({
      where: { userId, orgId: headerOrgId, isActive: true },
      select: { orgId: true },
    }).catch(() => null);
    if (!membership) return { userId, orgId: null, error: 'not_a_member' };
    return { userId, orgId: headerOrgId };
  }

  // No org named: resolve the user's active membership. Ordered so the choice
  // is deterministic rather than whatever the planner returns first.
  const membership = await prisma.userOrganization.findFirst({
    where: { userId, isActive: true },
    orderBy: { joinedAt: 'asc' },
    select: { orgId: true },
  }).catch(() => null);
  if (!membership) return { userId, orgId: null, error: 'no_active_org' };
  return { userId, orgId: membership.orgId };
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

function principalError(jsonResponse, res, principal) {
  if (principal.error === 'invalid_user') {
    return jsonResponse(res, { error: 'X-HM-User-Id must be a valid UUID' }, 400);
  }
  if (principal.error === 'not_a_member') {
    return jsonResponse(res, { error: 'the named organization is not one this user belongs to' }, 403);
  }
  if (principal.error === 'no_active_org') {
    return jsonResponse(res, { error: 'this user has no active organization membership' }, 403);
  }
  return null;
}

/**
 * Call hm-core's own API as the resolved principal.
 *
 * This is the same `internalFetch` the control plane already uses for
 * server-to-server calls, so the header contract (`X-API-Key` + principal) is
 * built in one place and cannot drift between callers.
 */
async function callCoreApi(path, { userId, orgId, method = 'GET', body = null } = {}) {
  const response = await internalFetch(`${coreApiBaseUrl()}${path}`, {
    service: 'hm-core',
    method,
    headers: { 'Content-Type': 'application/json' },
    body,
    userId,
    orgId,
    timeoutMs: BACKING_TIMEOUT_MS,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = payload?.message || payload?.error || `hm-core ${path} returned ${response.status}`;
    const error = new Error(reason);
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

function coreApiBaseUrl() {
  return (
    process.env.HIVEMIND_CORE_API_BASE_URL
    || process.env.HIVEMIND_API_URL
    || 'http://localhost:8050'
  ).replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST /internal/hivemind/recall — semantic search over the org's memory.
 *
 * Delegates to the canonical recall route so the runtime sees exactly what the
 * product's own recall sees: same ranking, same access context, same evidence.
 * A second recall implementation here would answer differently from the UI and
 * the difference would be invisible until someone compared two answers.
 */
export async function handleInternalRecallRoute({ req, res, jsonResponse, parseBody, prisma }) {
  const principal = await resolvePrincipal(req, prisma);
  const invalid = principalError(jsonResponse, res, principal);
  if (invalid) return invalid;

  const body = await parseBody(req).catch(() => ({}));
  const query = String(body?.query || '').trim();
  if (!query) return jsonResponse(res, { error: 'query is required' }, 400);
  const limit = Math.max(1, Math.min(Number(body?.limit || 8), 25));

  try {
    const payload = await callCoreApi('/api/recall', {
      ...principal,
      method: 'POST',
      body: { query, limit, mode: 'quick' },
    });
    return jsonResponse(res, {
      status: 'completed',
      query,
      count: Array.isArray(payload?.memories) ? payload.memories.length : 0,
      memories: payload?.memories || [],
      evidence: payload?.evidence || [],
    });
  } catch (err) {
    return jsonResponse(res, { error: err.message }, err.statusCode || 502);
  }
}

/**
 * POST /internal/hivemind/memories — persist a durable fact.
 *
 * `smartIngest` stays ON: a memory written by an agent is a memory the whole
 * org will later recall, so it must go through the same processing (entity
 * linking, contradiction detection, embedding) as a memory written by a human.
 * Skipping processing to make the write faster would produce a row that is
 * cheap to write and useless to read.
 */
export async function handleInternalSaveMemoryRoute({ req, res, jsonResponse, parseBody, prisma }) {
  const principal = await resolvePrincipal(req, prisma);
  const invalid = principalError(jsonResponse, res, principal);
  if (invalid) return invalid;

  const body = await parseBody(req).catch(() => ({}));
  const title = String(body?.title || '').trim().slice(0, 300);
  const content = String(body?.content || '').trim();
  if (!title || !content) {
    return jsonResponse(res, { error: 'title and content are required' }, 400);
  }
  const tags = Array.isArray(body?.tags)
    ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
    : [];

  try {
    const payload = await callCoreApi('/api/memories', {
      ...principal,
      method: 'POST',
      body: {
        title,
        content,
        tags,
        memory_type: 'fact',
        // Agent-authored memories are attributed so a later audit can tell
        // which rows came from a run rather than from a person.
        source: 'agent-runtime',
      },
    });
    return jsonResponse(res, {
      status: 'completed',
      memory_id: payload?.memory?.id || payload?.id || null,
      title,
    }, 201);
  } catch (err) {
    return jsonResponse(res, { error: err.message }, err.statusCode || 502);
  }
}

/**
 * GET /internal/hivemind/company-context — the org's operating profile.
 *
 * The profile lives on the org's Company HQ room (`agent_connectors._company`),
 * which is where onboarding writes it. Reading it from there rather than from a
 * second copy means the agent and the UI can never disagree about who the
 * company is.
 */
export async function handleInternalCompanyContextRoute({ req, res, jsonResponse, prisma }) {
  if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
  const principal = await resolvePrincipal(req, prisma);
  const invalid = principalError(jsonResponse, res, principal);
  if (invalid) return invalid;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, name, goal, "agent_connectors"->'_company' AS company
         FROM "hivemind"."hyper_rooms"
        WHERE org_id = $1::uuid AND archived_at IS NULL
          AND "agent_connectors" ? '_company'
        ORDER BY created_at DESC LIMIT 1`,
      principal.orgId,
    );
    const hq = rows?.[0];
    const operatorRow = await prisma.user.findUnique({
      where: { id: principal.userId },
      select: { id: true, email: true, displayName: true },
    }).catch(() => null);
    const displayName = String(operatorRow?.displayName || '').trim();
    const emailLocal = String(operatorRow?.email || '').split('@')[0] || '';
    const givenName = displayName.split(/\s+/).filter(Boolean)[0] || null;
    const operator = operatorRow ? {
      user_id: operatorRow.id,
      email: operatorRow.email || null,
      full_name: displayName || emailLocal || null,
      given_name: givenName,
      preferred_name: givenName,
    } : null;
    if (!hq) {
      // Not an error: an org that has not onboarded has no profile yet. The
      // agent must be told that plainly so it does not invent a target market.
      return jsonResponse(res, {
        status: 'completed',
        company: null,
        operator,
        note: 'No company profile is on file for this organization. Onboarding has not been completed.',
      });
    }
    const company = typeof hq.company === 'string' ? JSON.parse(hq.company) : hq.company;
    return jsonResponse(res, {
      status: 'completed',
      operator,
      company: {
        name: company?.name || hq.name || null,
        profile: company?.profile || null,
        mission: company?.mission || null,
        company_context: company?.company_context || null,
        website: company?.website || null,
        tasks: Array.isArray(company?.tasks) ? company.tasks : [],
      },
    });
  } catch (err) {
    return jsonResponse(res, { error: err.message }, 500);
  }
}

/**
 * POST /internal/hivemind/web-search — live external search.
 *
 * Delegates to the same `runWebSearchJob` the product's own search uses, so the
 * runtime inherits the quota, rate-limit, and abuse gates rather than opening a
 * second, ungated path to the search provider.
 */
export async function handleInternalWebSearchRoute({ req, res, jsonResponse, parseBody, prisma }) {
  const principal = await resolvePrincipal(req, prisma);
  const invalid = principalError(jsonResponse, res, principal);
  if (invalid) return invalid;

  const body = await parseBody(req).catch(() => ({}));
  const query = String(body?.query || '').trim();
  if (!query) return jsonResponse(res, { error: 'query is required' }, 400);
  const limit = Math.max(1, Math.min(Number(body?.limit || 10), 25));

  try {
    const payload = await callCoreApi('/api/web/search/jobs', {
      ...principal,
      method: 'POST',
      body: { query, limit },
    });
    return jsonResponse(res, {
      status: 'completed',
      query,
      results: payload?.results || [],
      answer: payload?.answer || null,
    });
  } catch (err) {
    return jsonResponse(res, { error: err.message }, err.statusCode || 502);
  }
}

/**
 * POST /internal/hivemind/artifacts — register a produced file.
 *
 * The workspace owns the bytes; hm-core owns the pointer. This records the
 * pointer as a `source_artifacts` row so the artifact is durable and citable.
 *
 * The `path` is workspace-relative and the runtime has already verified the
 * file exists and is non-empty — a claim of an artifact is not an artifact, and
 * this endpoint is the boundary where that claim becomes a row.
 */
export async function handleInternalRecordArtifactRoute({ req, res, jsonResponse, parseBody, prisma }) {
  if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
  const principal = await resolvePrincipal(req, prisma);
  const invalid = principalError(jsonResponse, res, principal);
  if (invalid) return invalid;

  const body = await parseBody(req).catch(() => ({}));
  const artifactPath = String(body?.path || '').trim().slice(0, 1000);
  const title = String(body?.title || '').trim().slice(0, 300);
  if (!artifactPath || !title) {
    return jsonResponse(res, { error: 'path and title are required' }, 400);
  }
  const contentType = String(body?.content_type || 'application/octet-stream').slice(0, 100);
  let workRunId = UUID_RE.test(String(body?.workrun_id || '')) ? String(body.workrun_id) : null;
  const agentScopeSessionId = String(body?.agentscope_session_id || '').trim().slice(0, 120);

  try {
    // The AgentScope tool factory receives the server-minted session id but
    // deliberately never exposes a WorkRun id to the model. Resolve that
    // session back to a run under the already-authenticated principal. This
    // keeps artifact ownership and preview hydration durable without creating
    // a second client-side or runtime-local source of truth.
    if (!workRunId && agentScopeSessionId) {
      const runs = await prisma.$queryRawUnsafe(
        `SELECT id FROM "hivemind"."work_runs"
          WHERE agentscope_session_id = $1
            AND user_id = $2::uuid
            AND org_id = $3::uuid
          ORDER BY updated_at DESC
          LIMIT 1`,
        agentScopeSessionId,
        principal.userId,
        principal.orgId,
      );
      const matchedId = runs?.[0]?.id;
      workRunId = UUID_RE.test(String(matchedId || '')) ? String(matchedId) : null;
    }

    // The checksum is over the identity of the artifact (its path + title), not
    // its bytes: the runtime holds the bytes in a sandbox hm-core cannot read,
    // and a pointer row is what makes the artifact citable. Dedup on this key
    // stops a re-run from filing the same deliverable twice.
    const checksum = await sha256Hex(`${principal.orgId}:${workRunId || ''}:${artifactPath}:${title}`);
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO "hivemind"."source_artifacts"
         (user_id, org_id, artifact_type, source_platform, source_id, content_type,
          checksum, storage_location, payload, metadata)
       VALUES ($1::uuid, $2::uuid, 'agent_output', 'agent-runtime', $3, $4,
               $5, $6, $7::jsonb, $8::jsonb)
       ON CONFLICT (user_id, org_id, checksum, source_platform)
       DO UPDATE SET metadata = "hivemind"."source_artifacts".metadata || $8::jsonb
       RETURNING id, created_at`,
      principal.userId,
      principal.orgId,
      workRunId,
      contentType,
      checksum,
      artifactPath,
      JSON.stringify({ title, path: artifactPath, workrun_id: workRunId }),
      JSON.stringify({ title, path: artifactPath, workrun_id: workRunId, registered_by: 'agent-runtime' }),
    );
    const artifact = rows?.[0];
    if (!artifact) return jsonResponse(res, { error: 'artifact insert returned no row' }, 500);

    // Link the artifact to its WorkRun so the run's result is inspectable.
    if (workRunId) {
      await prisma.$executeRawUnsafe(
        `UPDATE "hivemind"."work_runs"
            SET result_artifact_ids = result_artifact_ids || $1::jsonb
          WHERE id = $2::uuid AND org_id = $3::uuid`,
        JSON.stringify([artifact.id]),
        workRunId,
        principal.orgId,
      ).catch(() => { /* the artifact row is the durable record; the link is best-effort */ });
    }

    return jsonResponse(res, {
      status: 'completed',
      artifact_id: artifact.id,
      title,
      path: artifactPath,
    }, 201);
  } catch (err) {
    return jsonResponse(res, { error: err.message }, 500);
  }
}

async function sha256Hex(value) {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(String(value)).digest('hex');
}

/**
 * POST /internal/hyper/prospects — add a qualified prospect to the lead book.
 *
 * Prospects are CRM records, not memories. They live in `outreach_targets`
 * under an `outreach_campaigns` row, which is the store the "Your Leads" UI
 * already renders. Writing them as memories was tried and reverted: a prospect
 * row processed as a memory competes with real memories in semantic recall and
 * gets cited as a source for questions it has nothing to do with.
 *
 * The campaign is resolved-or-created per (org, user) so a run does not need to
 * know about campaign lifecycle to file a lead.
 */
export async function handleInternalSaveProspectRoute({ req, res, jsonResponse, parseBody, prisma }) {
  if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
  const principal = await resolvePrincipal(req, prisma);
  const invalid = principalError(jsonResponse, res, principal);
  if (invalid) return invalid;

  const body = await parseBody(req).catch(() => ({}));
  const company = String(body?.company || '').trim().slice(0, 300);
  const note = String(body?.note || '').trim().slice(0, 1600);
  if (!company || !note) {
    return jsonResponse(res, { error: 'company and note are required' }, 400);
  }
  const website = body?.website ? String(body.website).trim().slice(0, 500) : null;
  const email = body?.email ? String(body.email).trim().slice(0, 320) : null;
  const phone = body?.phone ? String(body.phone).trim().slice(0, 40) : null;

  try {
    const campaignId = await resolveLeadBookCampaign(prisma, principal);
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

    // Dedup on the company slug within the lead book: a re-run that rediscovers
    // a known lead updates its note instead of filing a duplicate row.
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM "hivemind"."outreach_targets"
        WHERE campaign_id = $1::uuid
          AND lower(regexp_replace(company, '[^a-zA-Z0-9]+', '-', 'g')) = $2
        LIMIT 1`,
      campaignId,
      slug,
    );
    if (existing?.[0]?.id) {
      await prisma.$executeRawUnsafe(
        `UPDATE "hivemind"."outreach_targets"
            SET input_context = input_context || $1::jsonb, updated_at = now()
          WHERE id = $2::uuid`,
        JSON.stringify({ notes: note, fit_rationale: note, source_url: website }),
        existing[0].id,
      );
      return jsonResponse(res, { status: 'completed', prospect_id: existing[0].id, company, updated: true });
    }

    const positionRows = await prisma.$queryRawUnsafe(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM "hivemind"."outreach_targets" WHERE campaign_id = $1::uuid',
      campaignId,
    );
    const position = Number(positionRows?.[0]?.next || 1);

    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO "hivemind"."outreach_targets"
         (campaign_id, position, company, email, phone, website, input_context, state)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, 'selected')
       RETURNING id`,
      campaignId,
      position,
      company,
      email,
      phone,
      website,
      JSON.stringify({
        notes: note,
        fit_rationale: note,
        source_url: website,
        discovered_by: 'agent-runtime',
      }),
    );
    return jsonResponse(res, {
      status: 'completed',
      prospect_id: rows?.[0]?.id || null,
      company,
    }, 201);
  } catch (err) {
    return jsonResponse(res, { error: err.message }, 500);
  }
}

/**
 * POST /internal/hivemind/composio/execute — run a connected provider tool.
 *
 * The Composio bridge. Composio holds the org's OAuth grants for third-party
 * providers (Gmail, Sheets, …), so this is how an agent acts on a connected
 * account without ever seeing a credential.
 *
 * Two things this endpoint deliberately does NOT do:
 *
 * 1. It does not accept a `user_id` for the provider call. Composio scopes
 *    connections by the id passed as `user_id`, and hm-core passes the ORG id —
 *    so a connection is shared by the org, not owned by whichever employee
 *    happened to run first. Passing the calling user would silently create a
 *    second, empty connection set for every employee.
 *
 * 2. It does not let the model choose the org. The org comes from the resolved
 *    principal, so a tool call cannot reach another tenant's connected accounts.
 */
export async function handleInternalComposioExecuteRoute({
  req, res, jsonResponse, parseBody, prisma, composioService,
}) {
  if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
  const principal = await resolvePrincipal(req, prisma);
  const invalid = principalError(jsonResponse, res, principal);
  if (invalid) return invalid;

  if (!composioService?.isComposioConfigured?.()) {
    return jsonResponse(res, { error: 'Composio is not configured on this deployment' }, 503);
  }

  const body = await parseBody(req).catch(() => ({}));
  const toolSlug = String(body?.tool || '').trim().slice(0, 200);
  if (!toolSlug) return jsonResponse(res, { error: 'tool is required' }, 400);
  const args = body?.args && typeof body.args === 'object' ? body.args : {};

  try {
    const result = await composioService.executeTool(principal.orgId, toolSlug, args);
    if (!result?.successful) {
      // A provider failure is a real failure. Returning 200 with
      // successful:false would let the model read it as a completed action.
      return jsonResponse(res, {
        error: result?.error || `Composio tool ${toolSlug} did not succeed`,
        tool: toolSlug,
      }, 502);
    }
    return jsonResponse(res, { status: 'completed', tool: toolSlug, data: result.data });
  } catch (err) {
    return jsonResponse(res, { error: err.message }, 502);
  }
}

/**
 * GET /internal/hivemind/composio/tools — what the org can actually call.
 *
 * Discovery, so the agent does not guess tool slugs. Returns only toolkits the
 * org has connected: listing every toolkit Composio offers would invite the
 * model to call one that has no grant behind it.
 */
export async function handleInternalResourceAccessRoute({
  req, res, jsonResponse, prisma,
}) {
  if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
  const principal = await resolvePrincipal(req, prisma);
  const invalid = principalError(jsonResponse, res, principal);
  if (invalid) return invalid;
  // Owner isolation is the default. Cross-owner shares are not stored yet.
  return jsonResponse(res, { status: 'completed', refs: [] });
}

export async function handleInternalPlaybookListRoute({
  req, res, jsonResponse, parseBody, prisma,
}) {
  if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
  const principal = await resolvePrincipal(req, prisma);
  const invalid = principalError(jsonResponse, res, principal);
  if (invalid) return invalid;
  const body = parseBody ? await parseBody(req).catch(() => ({})) : {};
  const sessionId = String(body.agentscope_session_id || '').trim();
  let roomPlaybook = null;
  let localPlaybook = null;
  if (sessionId) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT w.id, r.room_playbook, w.scope
         FROM "hivemind"."work_runs" w
         JOIN "hivemind"."hyper_rooms" r ON r.id = w.room_id
        WHERE w.agentscope_session_id = $1
          AND w.user_id = $2::uuid
          AND w.org_id = $3::uuid
        LIMIT 1`,
      sessionId,
      principal.userId,
      principal.orgId,
    );
    roomPlaybook = rows?.[0]?.room_playbook || null;
    localPlaybook = rows?.[0]?.scope?.local_playbooks || null;
  }
  const { listPlaybooks, organizationPlaybooks, localPlaybooks } = await import('../employees/playbook-catalog.js');
  return jsonResponse(res, {
    status: 'completed',
    playbooks: listPlaybooks({
      orgPlaybooks: organizationPlaybooks(roomPlaybook),
      localPlaybooks: localPlaybooks(localPlaybook),
    }),
  });
}

export async function handleInternalPlaybookGetRoute({
  req, res, jsonResponse, parseBody, prisma,
}) {
  if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
  const principal = await resolvePrincipal(req, prisma);
  const invalid = principalError(jsonResponse, res, principal);
  if (invalid) return invalid;
  const body = await parseBody(req).catch(() => ({}));
  const id = String(body?.id || '').trim();
  if (!id) return jsonResponse(res, { error: 'id is required' }, 400);
  const sessionId = String(body?.agentscope_session_id || '').trim();
  let roomPlaybook = null;
  let localPlaybook = null;
  let workRunId = null;
  if (sessionId) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT w.id, r.room_playbook, w.scope
         FROM "hivemind"."work_runs" w
         JOIN "hivemind"."hyper_rooms" r ON r.id = w.room_id
        WHERE w.agentscope_session_id = $1
          AND w.user_id = $2::uuid
          AND w.org_id = $3::uuid
        LIMIT 1`,
      sessionId,
      principal.userId,
      principal.orgId,
    );
    roomPlaybook = rows?.[0]?.room_playbook || null;
    localPlaybook = rows?.[0]?.scope?.local_playbooks || null;
    workRunId = rows?.[0]?.id || null;
  }
  const { getPlaybook, organizationPlaybooks, localPlaybooks } = await import('../employees/playbook-catalog.js');
  const playbook = getPlaybook(id, {
    orgPlaybooks: organizationPlaybooks(roomPlaybook),
    localPlaybooks: localPlaybooks(localPlaybook),
  });
  if (!playbook) return jsonResponse(res, { error: 'unknown playbook' }, 404);
  if (workRunId && sessionId) {
    // PlaybookGet is the selection boundary. Persist a validated catalog id
    // and version here, after resolving it under the bound session, instead
    // of trusting a model-supplied value at WorkRun creation time.
    await prisma.$queryRawUnsafe(
      `UPDATE "hivemind"."work_runs"
          SET playbook_id = $2, playbook_version = $3, updated_at = now()
        WHERE id = $1::uuid AND user_id = $4::uuid AND org_id = $5::uuid`,
      workRunId,
      playbook.id,
      playbook.version,
      principal.userId,
      principal.orgId,
    );
  }
  return jsonResponse(res, { status: 'completed', playbook });
}

export async function handleInternalComposioToolsRoute({
  req, res, jsonResponse, prisma, composioService,
}) {
  if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
  const principal = await resolvePrincipal(req, prisma);
  const invalid = principalError(jsonResponse, res, principal);
  if (invalid) return invalid;

  if (!composioService?.isComposioConfigured?.()) {
    return jsonResponse(res, { error: 'Composio is not configured on this deployment' }, 503);
  }

  try {
    const accounts = await composioService.listConnectedAccounts(principal.orgId);
    const toolkits = [...new Set((accounts || []).map((a) => a.toolkit).filter(Boolean))];
    return jsonResponse(res, {
      status: 'completed',
      connected_toolkits: toolkits,
      accounts: (accounts || []).map((a) => ({ toolkit: a.toolkit, status: a.status })),
    });
  } catch (err) {
    return jsonResponse(res, { error: err.message }, 502);
  }
}

/**
 * Resolve the lead-book campaign for a principal, creating one if absent.
 *
 * The lead book is a campaign-shaped store, but a WorkRun filing a lead does
 * not care about campaign lifecycle. This finds the org's standing lead-book
 * campaign (or creates it) so the caller only ever names a prospect.
 */
async function resolveLeadBookCampaign(prisma, { orgId, userId }) {
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id FROM "hivemind"."outreach_campaigns"
      WHERE org_id = $1::uuid AND user_id = $2::uuid
        AND channel = 'email'
      ORDER BY created_at DESC LIMIT 1`,
    orgId,
    userId,
  );
  if (existing?.[0]?.id) return existing[0].id;

  // A campaign row requires a room and a turn. Resolve the org's HQ room — the
  // same room the composer posts into — so the lead book is anchored to a real
  // surface rather than to a synthetic id.
  const hq = await prisma.$queryRawUnsafe(
    `SELECT id FROM "hivemind"."hyper_rooms"
      WHERE org_id = $1::uuid AND archived_at IS NULL
        AND "agent_connectors" ? '_company'
      ORDER BY created_at DESC LIMIT 1`,
    orgId,
  );
  const roomId = hq?.[0]?.id;
  if (!roomId) {
    throw new Error('no Company HQ room exists for this organization; onboard before filing prospects');
  }

  const turn = await prisma.$transaction(async (tx) => {
    const last = await tx.hyperTurn.findFirst({
      where: { roomId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    return tx.hyperTurn.create({
      data: {
        roomId,
        seq: (last?.seq ?? 0) + 1,
        userMessage: 'Lead book',
        // HyperTurn.status is constrained to live | complete | failed |
        // cost_capped. The lead-book anchor turn is created already finished —
        // it exists only to satisfy the campaign's turn_id FK, not to run.
        status: 'complete',
        idempotencyKey: `leadbook:${roomId}:${Date.now()}`.slice(0, 64),
        lines: [],
      },
    });
  });

  const created = await prisma.$queryRawUnsafe(
    `INSERT INTO "hivemind"."outreach_campaigns"
       (room_id, turn_id, user_id, org_id, channel, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'email', 'done')
     RETURNING id`,
    roomId,
    turn.id,
    userId,
    orgId,
  );
  const campaignId = created?.[0]?.id;
  if (!campaignId) throw new Error('lead book campaign insert returned no row');
  return campaignId;
}

export function describe() {
  return {
    module: 'internal-hivemind-routes',
    endpoints: [
      'POST /internal/hivemind/recall',
      'POST /internal/hivemind/memories',
      'GET  /internal/hivemind/company-context',
      'POST /internal/hivemind/web-search',
      'POST /internal/hivemind/artifacts',
      'POST /internal/hyper/prospects',
      'GET  /internal/hyper/prospects  (served by control-plane-server.js)',
    ],
  };
}

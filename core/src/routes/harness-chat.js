import crypto from 'node:crypto';
import { getRedisClient } from '../control-plane/session-store.js';
import {
  mintHarnessAdmissionTicket,
  registerHarnessTicketNonce,
} from '../harness-chat/admission-ticket.js';
import { evaluateHarnessChatFlag } from '../harness-chat/flag-client.js';
import { verifyHarnessRunnerServiceToken } from '../harness-chat/runner-service-token.js';
import {
  ConnectedAppReceiptError,
  readConnectedAppReceipt,
  storeConnectedAppReceipt,
} from '../harness-chat/connected-app-receipts.js';
import { getInternalApiKey } from '../security/internal-auth.js';
import { TeamStore } from '../teams/team-store.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function embedUrl(mode, env) {
  if (mode === 'harness') return env.HIVE_HARNESS_EMBED_URL || 'https://chat.singulancelabs.com/embed';
  return env.HIVE_HARNESS_LEGACY_EMBED_URL || '/hivemind/app/chat';
}

function legacyResponse(env, flagReceipt) {
  return { mode: 'legacy', embed_url: embedUrl('legacy', env), flag_receipt: flagReceipt };
}

const INTERNAL_PREFIX = '/internal/v1/harness-chat/core';
const RECEIPT_PREFIX = '/internal/v1/harness-chat/receipts';
const CREDIT_OPERATION_PREFIX = '/internal/v1/harness-chat/credit-operations';
const CORE_ROUTES = new Map([
  ['/api/profile', new Set(['GET'])],
  ['/api/profiles', new Set(['GET'])],
  ['/api/profiles/context', new Set(['GET'])],
  ['/api/recall', new Set(['POST'])],
  // The native DeepSeek Harness runtime intentionally exposes the compact
  // `/api/entities` contract. Core's canonical HTTP route is
  // `/api/entity-search`; keep the translation at this authenticated proxy
  // boundary so released runners do not need to know Core's internal route
  // spelling.
  ['/api/entities', new Set(['GET'])],
  ['/api/memories', new Set(['POST'])],
  // A completed HIVE save is reconciled through this bounded, tenant-scoped
  // receipt lookup after replay or a transport interruption. Keep it on the
  // same authenticated runner-to-Core proxy as the write; a public browser
  // route or a broad /api/memories wildcard would weaken that boundary.
  ['/api/memories/save-status', new Set(['GET'])],
]);
const CORE_ROUTE_TARGETS = new Map([
  ['/api/entities', '/api/entity-search'],
]);
const ENTITY_QUERY_KEYS = new Map([
  ['q', 'query'],
  ['limit', 'limit'],
  ['scope', 'scope'],
  ['project', 'project_id'],
]);

function boundedTimeout(value, fallback, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), max) : fallback;
}

function isRequestTimeout(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError'
    || /timed?\s*out|timeout/i.test(String(error?.message || ''));
}

function harnessCreditLimitResponse(summary) {
  const plan = summary?.plan || 'free';
  const nextPlan = { free: 'pro', pro: 'scale', scale: 'enterprise', enterprise_onboarding: 'enterprise', enterprise: null }[plan] ?? 'pro';
  return {
    error: 'plan_limit_exceeded',
    code: 'plan_limit_exceeded',
    message: 'Monthly credits exhausted',
    resource: 'credits',
    plan,
    limit: summary?.included ?? null,
    current: Number(summary?.used || 0) + Number(summary?.reserved || 0),
    remaining: summary?.remaining ?? 0,
    suggested_plan: nextPlan,
    upgrade_url: '/hivemind/app/billing',
  };
}

async function readJsonBounded(response, maxBytes = 2 * 1024 * 1024) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('upstream_response_too_large');
  try { return JSON.parse(text); } catch { throw new Error('upstream_invalid_json'); }
}

async function scopedHyperagentProfiles(prisma, claims) {
  const membership = await prisma.userOrganization.findUnique({
    where: { userId_orgId: { userId: claims.sub, orgId: claims.org_id } },
    select: { role: true, isActive: true },
  });
  if (!membership?.isActive) return null;
  const teamRows = await prisma.teamMember.findMany({
    where: { userId: claims.sub, team: { orgId: claims.org_id } }, select: { teamId: true },
  }).catch(() => []);
  const admin = membership.role === 'owner' || membership.role === 'admin';
  const rows = await prisma.digitalEmployee.findMany({
    where: {
      orgId: claims.org_id, archivedAt: null,
      ...(admin ? {} : { OR: [
        { scope: 'organization' },
        { scope: 'team', teamId: { in: teamRows.map(row => row.teamId) } },
        { createdBy: claims.sub },
      ] }),
    },
    select: {
      id: true, name: true, slug: true, avatarUrl: true, teamId: true, scope: true,
      status: true, persona: true, roleArchetype: true, peerReviewTargets: true,
      tools: true, policyRules: true,
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });
  return {
    ok: true, contract: 'hivemind.hyperagent-profiles.v1',
    scope: { user_id: claims.sub, org_id: claims.org_id, authority: 'server-derived-from-harness-ticket' },
    profiles: rows.map(row => ({
      id: row.id, name: row.name, slug: row.slug, avatar_url: row.avatarUrl || null,
      team_id: row.teamId || null, scope: row.scope, status: row.status, persona: row.persona,
      role_archetype: row.roleArchetype || null, peer_review_targets: row.peerReviewTargets || [],
      tools: row.tools || [], policy_rules: row.policyRules || {}, persona_contract: null,
      active_prompt_version: null,
    })),
    count: rows.length, generated_at: new Date().toISOString(),
  };
}

/** Return only the projects the ticket subject can read.  This deliberately
 * shares the dashboard's policy-aware TeamStore query rather than treating a
 * project id supplied by the browser as authorization. */
async function scopedProjects(prisma, claims) {
  const membership = await prisma.userOrganization.findUnique({
    where: { userId_orgId: { userId: claims.sub, orgId: claims.org_id } },
    select: { role: true, isActive: true },
  });
  if (!membership?.isActive) return null;
  const projects = await new TeamStore(prisma).listProjectsForUser({
    userId: claims.sub,
    orgId: claims.org_id,
    orgRole: membership.role || null,
  });
  const visible = claims.project_id === undefined
    ? projects
    : projects.filter(project => project.id === claims.project_id);
  return {
    ok: true,
    contract: 'hivemind.projects.v1',
    projects: visible.slice(0, 100).map(project => ({
      id: project.id,
      name: project.name,
      slug: project.slug,
    })),
  };
}

async function handleHarnessCoreProxy({ req, res, pathname, prisma, parseBody, jsonResponse, redisConfig, env, fetchImpl, creditService }) {
  const receiptRequest = pathname === RECEIPT_PREFIX || pathname.startsWith(`${RECEIPT_PREFIX}/`);
  const creditOperationRequest = pathname === CREDIT_OPERATION_PREFIX;
  if (!receiptRequest && !creditOperationRequest && !pathname.startsWith(`${INTERNAL_PREFIX}/`)) return false;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  let claims;
  try {
    claims = verifyHarnessRunnerServiceToken(bearer, { secret: env.HIVE_HARNESS_RUNNER_SERVICE_SECRET });
  } catch {
    jsonResponse(res, { error: 'Unauthorized' }, 401); return true;
  }
  const membership = await prisma?.userOrganization?.findUnique?.({
    where: { userId_orgId: { userId: claims.sub, orgId: claims.org_id } }, select: { isActive: true },
  });
  if (!membership?.isActive) { jsonResponse(res, { error: 'Organization membership required' }, 403); return true; }
  if (claims.project_id) {
    const project = await prisma?.project?.findFirst?.({ where: { id: claims.project_id, orgId: claims.org_id }, select: { id: true } });
    if (!project) { jsonResponse(res, { error: 'Project not found' }, 404); return true; }
  }
  if (creditOperationRequest) {
    if (req.method !== 'POST') { jsonResponse(res, { error: 'Method not allowed' }, 405); return true; }
    const input = await parseBody(req).catch(() => null);
    const sessionId = typeof input?.session_id === 'string' ? input.session_id : '';
    const callId = typeof input?.call_id === 'string' ? input.call_id : '';
    const turnId = Number.isSafeInteger(input?.turn_id) && input.turn_id >= 0 ? input.turn_id : -1;
    const kind = input?.kind;
    const tool = typeof input?.tool === 'string' ? input.tool : '';
    if (!/^session-[A-Za-z0-9-]{8,160}$/.test(sessionId) || !/^[A-Za-z0-9._:-]{1,180}$/.test(callId) || turnId < 0) {
      jsonResponse(res, { error: 'Invalid credit operation identity' }, 400); return true;
    }
    const service = kind === 'composio_execution' ? 'composio_tool_call'
      : kind === 'no_tool_turn' ? 'harness_no_tool_turn' : null;
    if ((kind !== 'turn_admission' && !service) || (service === 'composio_tool_call' && !/^[A-Za-z0-9_:-]{1,180}$/.test(tool))) {
      jsonResponse(res, { error: 'Invalid credit operation' }, 400); return true;
    }
    if (!creditService) { jsonResponse(res, { error: 'Credit service unavailable' }, 503); return true; }
    // This check is deliberately non-mutating. It guards the first model step,
    // while the terminal settlement path remains the sole debit authority.
    if (kind === 'turn_admission') {
      const summary = await creditService.getSummary(claims.org_id, claims.sub);
      if (!summary.unlimited && summary.remaining < 1) {
        jsonResponse(res, harnessCreditLimitResponse(summary), 402); return true;
      }
      jsonResponse(res, { admitted: true, remaining: summary.remaining, plan: summary.plan }, 200); return true;
    }
    if (service === 'harness_no_tool_turn') {
      const paid = await prisma.$queryRawUnsafe(
        `SELECT 1 FROM hivemind.usage_events
          WHERE org_id=$1::uuid AND initiating_user_id=$2::uuid AND metric='credits_consumed'
            AND state IN ('reserved','settled') AND metadata->>'service'='composio_tool_call'
            AND metadata->>'session_id'=$3 AND metadata->>'turn_id'=$4 LIMIT 1`,
        claims.org_id, claims.sub, sessionId, String(turnId),
      );
      if (paid.length > 0) { jsonResponse(res, { admitted: true, duplicate: true, service: 'composio_tool_call' }, 200); return true; }
    }
    const operationIdentity = `${service}\u0000${sessionId}\u0000${callId}`;
    const idempotencyKey = `harness:${crypto.createHash('sha256').update(operationIdentity).digest('hex')}`;
    const charged = await creditService.charge({
      orgId: claims.org_id, userId: claims.sub, service, units: 1, source: 'harness-runner',
      idempotencyKey,
      metadata: { session_id: sessionId, turn_id: String(turnId), call_id: callId, ...(tool ? { tool } : {}) },
    });
    if (!charged.admitted) { jsonResponse(res, { error: 'Credits exhausted', code: 'credits_exhausted' }, 402); return true; }
    jsonResponse(res, { admitted: true, duplicate: Boolean(charged.duplicate), service }, 200);
    return true;
  }
  if (pathname === RECEIPT_PREFIX && req.method === 'POST') {
    try {
      const input = await parseBody(req);
      const receipt = await storeConnectedAppReceipt({ prisma, owner: { orgId: claims.org_id, userId: claims.sub }, input, env });
      jsonResponse(res, {
        receipt_id: receipt.id, stored: true, bytes: receipt.contentBytes,
        expires_at: receipt.expiresAt.toISOString(), allowed_fields: receipt.allowedFields,
      }, 201);
    } catch (error) {
      const status = error instanceof ConnectedAppReceiptError ? error.status : 500;
      jsonResponse(res, { error: error instanceof ConnectedAppReceiptError ? error.code : 'receipt_store_failed' }, status);
    }
    return true;
  }
  const receiptRead = pathname.match(/^\/internal\/v1\/harness-chat\/receipts\/([0-9a-f-]{36})\/read$/i);
  if (receiptRead && req.method === 'POST') {
    try {
      const input = await parseBody(req);
      const result = await readConnectedAppReceipt({
        prisma, owner: { orgId: claims.org_id, userId: claims.sub }, receiptId: receiptRead[1],
        sessionId: input.session_id, requestedFields: input.fields, env,
      });
      jsonResponse(res, { receipt_id: receiptRead[1], fields: result });
    } catch (error) {
      const status = error instanceof ConnectedAppReceiptError ? error.status : 500;
      jsonResponse(res, { error: error instanceof ConnectedAppReceiptError ? error.code : 'receipt_read_failed' }, status);
    }
    return true;
  }
  const corePath = pathname.slice(INTERNAL_PREFIX.length);
  if (corePath === '/projects' && req.method === 'GET') {
    try {
      const result = await scopedProjects(prisma, claims);
      jsonResponse(res, result || { error: 'Organization membership required' }, result ? 200 : 403);
    } catch {
      jsonResponse(res, { error: 'Project catalog unavailable' }, 503);
    }
    return true;
  }
  if (corePath === '/v1/hyperagents/profiles' && req.method === 'GET') {
    const result = await scopedHyperagentProfiles(prisma, claims);
    jsonResponse(res, result || { error: 'Organization membership required' }, result ? 200 : 403);
    return true;
  }
  if (!CORE_ROUTES.get(corePath)?.has(req.method)) {
    jsonResponse(res, { error: 'Harness core operation not allowed' }, 404); return true;
  }
  let body;
  if (req.method !== 'GET') body = await parseBody(req).catch(() => null);
  const target = new URL(CORE_ROUTE_TARGETS.get(corePath) || corePath, redisConfig.coreApiBaseUrl);
  if (corePath === '/api/entities') {
    const incoming = new URL(req.url || pathname, 'http://harness.internal');
    for (const [incomingKey, coreKey] of ENTITY_QUERY_KEYS) {
      const value = incoming.searchParams.get(incomingKey);
      if (value !== null) target.searchParams.set(coreKey, value);
    }
  }
  if (corePath === '/api/memories') target.searchParams.set('sync', 'true');
  const headers = {
    accept: 'application/json', authorization: `Bearer ${getInternalApiKey()}`,
    'x-hm-user-id': claims.sub, 'x-hm-org-id': claims.org_id,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  const requestCore = (requestBody, timeoutMs) => fetchImpl(target, {
    method: req.method,
    headers,
    ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
    redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
  });
  const primaryTimeoutMs = boundedTimeout(env.HIVE_HARNESS_CORE_PRIMARY_TIMEOUT_MS, 12_000, 17_000);
  const fallbackTimeoutMs = boundedTimeout(env.HIVE_HARNESS_CORE_FALLBACK_TIMEOUT_MS, 4_000, 5_000);
  let upstream;
  try {
    upstream = await requestCore(body, primaryTimeoutMs);
  } catch (error) {
    if (!isRequestTimeout(error) || corePath !== '/api/recall') throw error;
    // A slow optional embedding/reliability provider must not consume the
    // runner's complete 20-second tool budget. Retry once through Core's
    // bounded quick-recall plan, preserving tenant and all hard filters.
    try {
      upstream = await requestCore({
        ...(body || {}),
        mode: 'quick',
        max_memories: Math.min(Number(body?.max_memories || body?.limit || 5), 5),
      }, fallbackTimeoutMs);
    } catch (fallbackError) {
      if (!isRequestTimeout(fallbackError)) throw fallbackError;
      jsonResponse(res, {
        error: 'memory_retrieval_timeout',
        message: 'Memory retrieval exceeded its bounded deadline. No absence conclusion was made.',
        retryable: true,
      }, 503);
      return true;
    }
  }
  const payload = await readJsonBounded(upstream);
  jsonResponse(res, payload, upstream.status);
  return true;
}

export async function handleHarnessChatBootstrapRoute({
  req,
  res,
  pathname,
  prisma,
  requireSession,
  parseBody,
  jsonResponse,
  redisConfig,
  getRedis = getRedisClient,
  env = process.env,
  fetchImpl = globalThis.fetch,
  creditService,
} = {}) {
  if (await handleHarnessCoreProxy({ req, res, pathname, prisma, parseBody, jsonResponse, redisConfig, env, fetchImpl, creditService })) return true;
  const dedicatedNewSession = pathname === '/v1/harness-chat/new-session';
  if ((!dedicatedNewSession && pathname !== '/v1/harness-chat/bootstrap') || req.method !== 'POST') return false;
  const current = await requireSession(req, res);
  if (!current) return true;
  const { userId, orgId } = current.session || {};
  if (!UUID_RE.test(userId) || !UUID_RE.test(orgId)) {
    jsonResponse(res, { error: 'Authenticated tenant scope required' }, 403);
    return true;
  }
  const membership = await prisma?.userOrganization?.findUnique?.({
    where: { userId_orgId: { userId, orgId } },
    select: { userId: true },
  });
  if (!membership) {
    jsonResponse(res, { error: 'Organization membership required' }, 403);
    return true;
  }

  const body = await parseBody(req).catch(() => ({}));
  const projectId = typeof body?.project_id === 'string' ? body.project_id : null;
  if (projectId && !UUID_RE.test(projectId)) {
    jsonResponse(res, { error: 'Invalid project scope' }, 400);
    return true;
  }
  if (projectId) {
    const project = await prisma?.project?.findFirst?.({ where: { id: projectId, orgId }, select: { id: true } });
    if (!project) {
      jsonResponse(res, { error: 'Project not found' }, 404);
      return true;
    }
  }

  // A direct /new route selects session semantics only. It must not bypass
  // the server-side rollout decision: a disabled workspace remains legacy.
  const evaluated = await evaluateHarnessChatFlag({
    endpoint: env.HIVE_HARNESS_FLAG_URL || 'https://next.singulancelabs.com/__hivemind/feature-flags/harness-chat',
    secret: env.HIVE_HARNESS_EDGE_EVAL_SECRET,
    orgId,
    userId,
    fetchImpl,
    timeoutMs: Number(env.HIVE_HARNESS_FLAG_TIMEOUT_MS || 2000),
  });
  // Admission is intentionally binary.  Unknown or retired rollout values
  // fail closed to the established LangGraph/LangChain orchestrator rather
  // than placing a browser on a partially admitted native route.
  const evaluation = dedicatedNewSession && evaluated.mode === 'harness'
    ? {
        ...evaluated,
        mode: 'harness',
        flagReceipt: { ...evaluated.flagReceipt, source: 'dedicated-new-session-route' },
      }
    : evaluated;
  if (evaluation.mode !== 'harness') {
    jsonResponse(res, legacyResponse(env, evaluation.flagReceipt));
    return true;
  }

  try {
    const ticketSecret = env.HIVE_HARNESS_TICKET_SECRET;
    if ([env.HIVEMIND_CONTROL_PLANE_SESSION_SECRET, env.SESSION_SECRET, env.HIVEMIND_MASTER_API_KEY]
      .filter(Boolean).includes(ticketSecret)) {
      const error = new Error('ticket_secret_not_distinct');
      error.code = 'ticket_secret_not_distinct';
      throw error;
    }
    const minted = mintHarnessAdmissionTicket({
      secret: ticketSecret,
      userId,
      orgId,
      projectId,
      variation: evaluation.mode,
    });
    const redis = await getRedis(redisConfig || {});
    await registerHarnessTicketNonce(redis, minted.ticket, minted.claims);
    jsonResponse(res, {
      mode: evaluation.mode,
      embed_url: embedUrl(evaluation.mode, env),
      ticket: minted.ticket,
      expires_at: new Date(minted.claims.exp * 1000).toISOString(),
      flag_receipt: evaluation.flagReceipt,
    });
  } catch (error) {
    console.warn('[harness-chat.bootstrap] admission unavailable:', error?.code || error?.message || error);
    // A successful Flagship evaluation is the sole surface decision.  A later
    // admission outage must not masquerade as an explicit legacy rollout.
    jsonResponse(res, {
      error: 'harness_admission_unavailable',
      code: 'harness_admission_unavailable',
      message: 'HIVE-MIND chat is temporarily unavailable. Please retry.',
      flag_receipt: evaluation.flagReceipt,
    }, 503);
  }
  return true;
}

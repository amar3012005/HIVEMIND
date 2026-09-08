import { getRedisClient } from '../control-plane/session-store.js';
import {
  mintHarnessAdmissionTicket,
  registerHarnessTicketNonce,
} from '../harness-chat/admission-ticket.js';
import { evaluateHarnessChatFlag } from '../harness-chat/flag-client.js';
import { verifyHarnessRunnerServiceToken } from '../harness-chat/runner-service-token.js';
import { getInternalApiKey } from '../security/internal-auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function embedUrl(mode, env) {
  if (mode === 'harness') return env.HIVE_HARNESS_EMBED_URL || 'https://chat.singulancelabs.com/embed';
  if (mode === 'preview') return env.HIVE_HARNESS_PREVIEW_EMBED_URL || 'https://chat.singulancelabs.com/preview';
  return env.HIVE_HARNESS_LEGACY_EMBED_URL || '/hivemind/app/chat';
}

function legacyResponse(env, flagReceipt) {
  return { mode: 'legacy', embed_url: embedUrl('legacy', env), flag_receipt: flagReceipt };
}

const INTERNAL_PREFIX = '/internal/v1/harness-chat/core';
const CORE_ROUTES = new Map([
  ['/api/profile', new Set(['GET'])],
  ['/api/profiles', new Set(['GET'])],
  ['/api/profiles/context', new Set(['GET'])],
  ['/api/recall', new Set(['POST'])],
  ['/api/memories', new Set(['POST'])],
]);

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

async function handleHarnessCoreProxy({ req, res, pathname, prisma, parseBody, jsonResponse, redisConfig, env, fetchImpl }) {
  if (!pathname.startsWith(`${INTERNAL_PREFIX}/`)) return false;
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
  const corePath = pathname.slice(INTERNAL_PREFIX.length);
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
  const target = new URL(corePath, redisConfig.coreApiBaseUrl);
  if (corePath === '/api/memories') target.searchParams.set('sync', 'true');
  const upstream = await fetchImpl(target, {
    method: req.method,
    headers: {
      accept: 'application/json', authorization: `Bearer ${getInternalApiKey()}`,
      'x-hm-user-id': claims.sub, 'x-hm-org-id': claims.org_id,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual', signal: AbortSignal.timeout(20_000),
  });
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
} = {}) {
  if (await handleHarnessCoreProxy({ req, res, pathname, prisma, parseBody, jsonResponse, redisConfig, env, fetchImpl })) return true;
  if (pathname !== '/v1/harness-chat/bootstrap' || req.method !== 'POST') return false;
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

  const evaluation = await evaluateHarnessChatFlag({
    endpoint: env.HIVE_HARNESS_FLAG_URL || 'https://chat.singulancelabs.com/__hivemind/feature-flags/harness-chat',
    secret: env.HIVE_HARNESS_EDGE_EVAL_SECRET,
    orgId,
    userId,
    fetchImpl,
    timeoutMs: Number(env.HIVE_HARNESS_FLAG_TIMEOUT_MS || 2000),
  });
  if (evaluation.mode === 'legacy') {
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
    jsonResponse(res, legacyResponse(env, evaluation.flagReceipt));
  }
  return true;
}

import { getRedisClient } from '../control-plane/session-store.js';
import {
  mintHarnessAdmissionTicket,
  registerHarnessTicketNonce,
} from '../harness-chat/admission-ticket.js';
import { evaluateHarnessChatFlag } from '../harness-chat/flag-client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function embedUrl(mode, env) {
  if (mode === 'harness') return env.HIVE_HARNESS_EMBED_URL || 'https://chat.singulancelabs.com/embed';
  if (mode === 'preview') return env.HIVE_HARNESS_PREVIEW_EMBED_URL || 'https://chat.singulancelabs.com/preview';
  return env.HIVE_HARNESS_LEGACY_EMBED_URL || '/hivemind/app/chat';
}

function legacyResponse(env, flagReceipt) {
  return { mode: 'legacy', embed_url: embedUrl('legacy', env), flag_receipt: flagReceipt };
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
  if (pathname !== '/v1/harness-chat/bootstrap' || req.method !== 'POST') return false;
  const current = await requireSession(req, res);
  if (!current) return true;
  const { userId, orgId } = current.session || {};
  if (!UUID_RE.test(userId) || !UUID_RE.test(orgId)) {
    jsonResponse(res, { error: 'Authenticated tenant scope required' }, 403);
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
    const minted = mintHarnessAdmissionTicket({
      secret: env.HIVE_HARNESS_TICKET_SECRET,
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

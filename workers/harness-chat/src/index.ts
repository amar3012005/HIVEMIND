export const HIVE_HARNESS_CHAT_FLAG_KEY = 'hivemind_harness_chat_v1';
export type HarnessChatMode = 'legacy' | 'preview' | 'harness';

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Flagship {
  getStringDetails(key: string, fallback: string, context: Record<string, string>): Promise<{
    value: string;
    evaluationId?: string;
  }>;
}

export interface Env {
  ASSETS: Fetcher;
  FLAGS: Flagship;
  ENVIRONMENT: 'local' | 'production';
  HIVE_HARNESS_CHAT_FLAG?: string;
  HIVE_HARNESS_EDGE_EVAL_SECRET: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set<HarnessChatMode>(['legacy', 'preview', 'harness']);

function constantTimeBearer(request: Request, secret: string): boolean {
  const expected = `Bearer ${secret || ''}`;
  const actual = request.headers.get('authorization') || '';
  if (!secret || actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < actual.length; index += 1) mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return mismatch === 0;
}

export async function evaluateHarnessChatMode(env: Env, orgId: string, userId: string): Promise<{
  key: string;
  source: 'cloudflare-flagship';
  variation: HarnessChatMode;
  evaluation_id?: string;
}> {
  const fallback = { key: HIVE_HARNESS_CHAT_FLAG_KEY, source: 'cloudflare-flagship' as const, variation: 'legacy' as const };
  if (!UUID_RE.test(orgId) || !UUID_RE.test(userId) || !['local', 'production'].includes(env.ENVIRONMENT)) return fallback;
  try {
    const details = await env.FLAGS.getStringDetails(
      env.HIVE_HARNESS_CHAT_FLAG || HIVE_HARNESS_CHAT_FLAG_KEY,
      'legacy',
      { targetingKey: `${orgId}:${userId}`, org_id: orgId, user_id: userId, environment: env.ENVIRONMENT },
    );
    const variation = MODES.has(details.value as HarnessChatMode) ? details.value as HarnessChatMode : 'legacy';
    const evaluationId = (details as { evaluationId?: string }).evaluationId;
    return { ...fallback, variation, ...(evaluationId ? { evaluation_id: evaluationId } : {}) };
  } catch {
    return fallback;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__hivemind/feature-flags/harness-chat') {
      if (request.method !== 'GET') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
      if (!constantTimeBearer(request, env.HIVE_HARNESS_EDGE_EVAL_SECRET)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return Response.json(await evaluateHarnessChatMode(
        env,
        url.searchParams.get('org_id') || '',
        url.searchParams.get('user_id') || '',
      ), { headers: { 'cache-control': 'no-store' } });
    }
    return env.ASSETS.fetch(request);
  },
};

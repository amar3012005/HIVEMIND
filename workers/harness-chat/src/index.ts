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
  HIVE_HARNESS_EDGE_EVAL_SECRET: string;
  RUNNER_ORIGIN: string;
  HIVE_HARNESS_PARENT_ORIGINS: string;
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
      HIVE_HARNESS_CHAT_FLAG_KEY,
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

function assetSecurityHeaders(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  const parents = String(env.HIVE_HARNESS_PARENT_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  headers.set('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https: wss:; object-src 'none'; base-uri 'self'; frame-ancestors ${parents.length ? parents.join(' ') : "'none'"}`);
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isRunnerRoute(pathname: string): boolean {
  return pathname === '/health' || pathname === '/api/remote.mux' || pathname.startsWith('/api/');
}

async function proxyRunner(request: Request, env: Env): Promise<Response> {
  if (!env.RUNNER_ORIGIN) return Response.json({ error: 'runner_unavailable' }, { status: 503 });
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, env.RUNNER_ORIGIN);
  return fetch(new Request(target, {
    method: request.method,
    headers: request.headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  }));
}

export const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__hivemind/feature-flags/harness-chat') {
      if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
      if (!constantTimeBearer(request, env.HIVE_HARNESS_EDGE_EVAL_SECRET)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const body = await request.json().catch(() => ({})) as { org_id?: string; user_id?: string };
      return Response.json(await evaluateHarnessChatMode(env, body.org_id || '', body.user_id || ''),
        { headers: { 'cache-control': 'no-store' } });
    }
    if (isRunnerRoute(url.pathname)) return proxyRunner(request, env);
    return assetSecurityHeaders(await env.ASSETS.fetch(request), env);
  },
};

export default worker;

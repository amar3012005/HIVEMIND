const HIVE_HARNESS_CHAT_FLAG_KEY = 'hivemind_harness_chat_v1';
const HIVE_COMPACT_TOPBAR_FLAG_KEY = 'hivemind_compact_topbar_v1';
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

export async function evaluateUiShell(env: Env): Promise<{ key: string; variation: 'full' | 'compact'; evaluation_id?: string }> {
  const fallback = env.ENVIRONMENT === 'local' ? 'compact' : 'full';
  try {
    const details = await env.FLAGS.getStringDetails(
      HIVE_COMPACT_TOPBAR_FLAG_KEY,
      fallback,
      { targetingKey: env.ENVIRONMENT, environment: env.ENVIRONMENT },
    );
    const variation = details.value === 'compact' ? 'compact' : 'full';
    return { key: HIVE_COMPACT_TOPBAR_FLAG_KEY, variation, ...(details.evaluationId ? { evaluation_id: details.evaluationId } : {}) };
  } catch {
    return { key: HIVE_COMPACT_TOPBAR_FLAG_KEY, variation: fallback };
  }
}

function assetSecurityHeaders(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  const parents = String(env.HIVE_HARNESS_PARENT_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  headers.set('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https: wss:; object-src 'none'; base-uri 'self'; frame-ancestors ${parents.length ? parents.join(' ') : "'none'"}`);
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('permissions-policy', 'camera=(), microphone=(self), geolocation=()');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isRunnerRoute(pathname: string): boolean {
  return pathname === '/health' || pathname === '/api/remote.mux' || pathname.startsWith('/api/');
}

function isEstablishPath(pathname: string): boolean {
  return pathname === '/api/hivemind/embed/exchange' || pathname === '/api/hivemind/session/establish';
}

function isWebSocketUpgrade(request: Request): boolean {
  return (request.headers.get('upgrade') || '').toLowerCase() === 'websocket';
}

function cacheClientPlugin(request: Request, response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  const revision = new URL(request.url).searchParams.get('rev');
  const versioned = revision !== null && /^[A-Za-z0-9_-]{8,128}$/.test(revision);
  const cacheable = (request.method === 'GET' || request.method === 'HEAD')
    && response.ok
    && !headers.has('set-cookie');
  // Plugin URLs are profile-resolved rather than content hashed. Keep them in
  // the authenticated browser cache only, and revalidate quickly so a new
  // release cannot leave an old plugin mounted for long. Never edge-share a
  // tenant-resolved plugin or cache a response which changes authentication.
  headers.set('cache-control', cacheable
    ? versioned ? 'private, max-age=31536000, immutable' : 'private, max-age=60, stale-while-revalidate=300'
    : 'private, no-store');
  headers.append('vary', 'Cookie');
  return assetSecurityHeaders(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }), env);
}

async function proxyRunner(request: Request, env: Env): Promise<Response> {
  if (!env.RUNNER_ORIGIN) return Response.json({ error: 'runner_unavailable' }, { status: 503 });
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, env.RUNNER_ORIGIN);
  const headers = new Headers(request.headers);
  // Preserve the browser-visible authority for the runner's same-origin and
  // authority-bound cookie checks while the upstream Host targets the tunnel.
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', incoming.protocol.slice(0, -1));
  const contentType = (headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const parentNavigation = isEstablishPath(incoming.pathname)
    && contentType === 'application/x-www-form-urlencoded';
  const keepBrowserOrigin = isEstablishPath(incoming.pathname)
    || incoming.pathname === '/api/remote.mux'
    || incoming.pathname === '/api/hivemind/boot';
  if (!keepBrowserOrigin && !parentNavigation && headers.get('origin') === incoming.origin) {
    headers.set('origin', target.origin);
  }
  if (incoming.pathname === '/api/remote.mux' && isWebSocketUpgrade(request)) {
    headers.set('upgrade', 'websocket');
    headers.set('connection', 'Upgrade');
    return fetch(new Request(target, { method: 'GET', headers, redirect: 'manual' }));
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const upstream = await fetch(new Request(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    ...(hasBody ? { duplex: 'half' } : {}),
    credentials: 'include',
    redirect: 'manual',
  } as RequestInit));
  console.log(JSON.stringify({
    event: 'harness_runner_proxy',
    path: incoming.pathname,
    status: upstream.status,
    upgrade: isWebSocketUpgrade(request),
    request_cookie: headers.has('cookie'),
    response_cookie: upstream.headers.has('set-cookie'),
  }));
  return upstream;
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
    if (url.pathname === '/__hivemind/feature-flags/ui-shell') {
      if (request.method !== 'GET') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
      return Response.json(await evaluateUiShell(env), { headers: { 'cache-control': 'private, max-age=30' } });
    }
    if (url.pathname.startsWith('/plugins/')) {
      return cacheClientPlugin(request, await proxyRunner(request, env), env);
    }
    if (isRunnerRoute(url.pathname)) return proxyRunner(request, env);
    return assetSecurityHeaders(await env.ASSETS.fetch(request), env);
  },
};

export default worker;

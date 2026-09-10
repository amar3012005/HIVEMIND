const HIVE_HARNESS_CHAT_FLAG_KEY = 'hivemind_harness_chat_v1';
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

type BootInjection =
  | { kind: 'global'; name: string; value: unknown }
  | { kind: 'script'; placement: 'head' | 'body'; text: string }
  | { kind: 'script-src'; placement: 'head' | 'body'; src: string }
  | { kind: 'script-preload'; src: string }
  | { kind: 'style'; text: string }
  | { kind: 'html'; placement: 'head' | 'body'; html: string };

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
  // Local preview is an explicit canary environment, not a production rollout
  // audience. It must exercise the real Harness admission path regardless of
  // the remote production default, while still requiring server-derived IDs.
  if (env.ENVIRONMENT === 'local') {
    return { ...fallback, variation: 'harness' };
  }
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
  // Native Harness composes certain locally trusted runtime modules with
  // Function(). This isolated HIVE origin has no filesystem/developer plugin
  // surface; blocking unsafe-eval here prevents the native client from booting.
  headers.set('content-security-policy', `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https: wss:; object-src 'none'; base-uri 'self'; frame-ancestors ${parents.length ? parents.join(' ') : "'none'"}`);
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function renderBootIndex(html: string, rows: BootInjection[]): string {
  let head = '';
  let body = '';
  for (const row of rows) {
    let placement: 'head' | 'body' = 'head';
    let markup = '';
    if (row.kind === 'global') {
      const name = JSON.stringify(row.name).replaceAll('<', '\\u003c');
      const value = row.value === undefined ? 'undefined' : JSON.stringify(row.value).replaceAll('<', '\\u003c');
      markup = `<script>globalThis[${name}]=${value}</script>`;
    } else if (row.kind === 'script') {
      placement = row.placement; markup = `<script>${row.text}</script>`;
    } else if (row.kind === 'script-src') {
      placement = row.placement; markup = `<script src="${escapeAttribute(row.src)}"></script>`;
    } else if (row.kind === 'script-preload') {
      markup = `<link rel="preload" as="script" href="${escapeAttribute(row.src)}">`;
    } else if (row.kind === 'style') {
      markup = `<style>${row.text}</style>`;
    } else if (row.kind === 'html') {
      placement = row.placement; markup = row.html;
    }
    if (placement === 'head') head += markup; else body += markup;
  }
  body += '<script>(globalThis.__DSH_BOOT_READY__??=Promise.withResolvers()).resolve()</script>';
  return html.replace(/<head([^>]*)>/i, match => `${match}${head}`)
    .replace(/<body([^>]*)>/i, match => `${match}${body}`);
}

function authCallback(request: Request): Response {
  const preview = new URL(request.url).hostname.includes('.preview.');
  const hiveOverview = preview
    ? 'https://next.preview.singulancelabs.com/hivemind/app/new-session'
    : 'https://next.singulancelabs.com/hivemind/app/new-session';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening HIVE-MIND</title><style>html,body{height:100%;margin:0;background:#faf9f4;color:#737373;font:13px system-ui,sans-serif}body{display:grid;place-items:center}.card{text-align:center}.bar{width:176px;height:4px;margin:14px auto;overflow:hidden;border-radius:99px;background:#e7e4dc}.bar:after{display:block;width:50%;height:100%;content:"";border-radius:99px;background:#117dff;animation:load 1s ease-in-out infinite alternate}@keyframes load{to{transform:translateX(100%)}}a{color:#117dff}.error{display:none}</style></head><body><main class="card"><strong>Opening HIVE-MIND</strong><div class="bar"></div><div id="status">Securing your Harness session…</div><p class="error" id="error">This sign-in link expired. <a href="${hiveOverview}">Return to HIVE-MIND</a></p></main><script>(()=>{const p=new URLSearchParams(location.hash.slice(1));const ticket=p.get('ticket');const requestId=p.get('request_id')||crypto.randomUUID();history.replaceState(null,'','/auth/callback');const fail=()=>{document.querySelector('.bar').style.display='none';document.querySelector('#status').style.display='none';document.querySelector('#error').style.display='block'};if(!ticket){fail();return}fetch('/api/hivemind/embed/exchange',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({ticket,request_id:requestId})}).then(r=>{if(!r.ok)throw new Error();location.replace('/')}).catch(fail)})()</script></body></html>`;
  return new Response(html, {
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet',
    },
  });
}

/**
 * Static Harness is served at the edge. The runner is deliberately not in the
 * document/JS/CSS path: it owns only authenticated API and stream routes.
 * The former runner index injected this small parent-origin contract, so
 * retain it when static assets are served by the Worker.
 */
async function staticHarness(request: Request, env: Env): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);
  const contentType = asset.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    return assetSecurityHeaders(asset, env);
  }
  const bootUrl = new URL('/api/hivemind/boot', request.url);
  const boot = await proxyRunner(new Request(bootUrl, { headers: request.headers }), env);
  // A document navigation must never expose the runner's plain-text admission
  // error.  This worker is mounted beneath the HIVE application origin, so an
  // expired, missing, or rejected admission returns the browser to the normal
  // HIVE sign-in boundary.  Clearing the marker also prevents a stale cookie
  // from repeatedly routing future documents back here.
  if (!boot.ok) {
    const parent = String(env.HIVE_HARNESS_PARENT_ORIGINS || '').split(',').map(value => value.trim()).find(Boolean);
    const login = new URL('/hivemind/login', parent || request.url);
    return new Response(null, {
      status: 302,
      headers: {
        'cache-control': 'no-store',
        location: login.toString(),
        'set-cookie': 'hm_harness_admitted=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict',
      },
    });
  }
  const payload = await boot.json() as { version?: number; injections?: BootInjection[] };
  if (payload.version !== 1 || !Array.isArray(payload.injections)) {
    return new Response('HIVE-MIND boot unavailable', { status: 503 });
  }
  const html = renderBootIndex(await asset.text(), payload.injections);
  const headers = new Headers(asset.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'private, no-store');
  return assetSecurityHeaders(new Response(html, { status: asset.status, headers }), env);
}

function isRunnerRoute(pathname: string): boolean {
  // Cloudflare owns the complete browser application, including the document.
  // The runner is only the authenticated runtime boundary. `/plugins` remains
  // dynamic because it is the resolved HIVE Cordis profile, not SPA chrome.
  return pathname === '/health' || pathname.startsWith('/plugins/')
    || pathname === '/api/remote.mux' || pathname.startsWith('/api/');
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
  // JSON calls become same-origin with the private runner during the internal
  // Worker-to-tunnel hop. Parent form navigation retains its HIVE origin for
  // the runner's explicit parent allowlist.
  const contentType = (headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const parentNavigation = incoming.pathname === '/api/hivemind/embed/exchange'
    && contentType === 'application/x-www-form-urlencoded';
  if (!parentNavigation && headers.get('origin') === incoming.origin) {
    headers.set('origin', target.origin);
  }
  const upstream = await fetch(new Request(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    credentials: 'include',
    redirect: 'manual',
  }));
  console.log(JSON.stringify({
    event: 'harness_runner_proxy',
    path: incoming.pathname,
    status: upstream.status,
    request_cookie: headers.has('cookie'),
    response_cookie: upstream.headers.has('set-cookie'),
  }));
  return upstream;
}

export const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/auth/callback') {
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
      return authCallback(request);
    }
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
    return staticHarness(request, env);
  },
};

export default worker;

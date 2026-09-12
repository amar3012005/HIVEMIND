import { describe, expect, it, vi } from 'vitest';
import { evaluateHarnessChatMode, worker, type Env } from '../src/index';

const HIVE_HARNESS_CHAT_FLAG_KEY = 'hivemind_harness_chat_v1';

const orgId = '67503d34-97e9-49a8-8c52-8ee30cc7603e';
const userId = '54f5568b-4d6a-4ae1-9a33-48cb2909d59b';

describe('harness chat Flagship gate', () => {
  it('accepts only the three contract variations and uses tenant targeting', async () => {
    const getStringDetails = vi.fn(async () => ({ value: 'harness', evaluationId: 'eval-1' }));
    const env = { ENVIRONMENT: 'production', FLAGS: { getStringDetails } } as unknown as Env;
    expect(await evaluateHarnessChatMode(env, orgId, userId)).toEqual({
      key: HIVE_HARNESS_CHAT_FLAG_KEY,
      source: 'cloudflare-flagship',
      variation: 'harness',
      evaluation_id: 'eval-1',
    });
    expect(getStringDetails).toHaveBeenCalledWith(HIVE_HARNESS_CHAT_FLAG_KEY, 'legacy', {
      targetingKey: `${orgId}:${userId}`, org_id: orgId, user_id: userId, environment: 'production',
    });
  });

  it('fails closed on invalid variations, invalid scope, and provider errors', async () => {
    const env = { ENVIRONMENT: 'production', FLAGS: {
      getStringDetails: vi.fn(async () => ({ value: 'enabled' })),
    } } as unknown as Env;
    expect((await evaluateHarnessChatMode(env, orgId, userId)).variation).toBe('legacy');
    expect((await evaluateHarnessChatMode(env, 'invalid', userId)).variation).toBe('legacy');
    env.FLAGS.getStringDetails = vi.fn(async () => { throw new Error('unavailable'); });
    expect((await evaluateHarnessChatMode(env, orgId, userId)).variation).toBe('legacy');
  });

  it('admits the full Harness only for a valid local tenant scope', async () => {
    const env = { ENVIRONMENT: 'local', FLAGS: { getStringDetails: vi.fn() } } as unknown as Env;
    expect((await evaluateHarnessChatMode(env, orgId, userId)).variation).toBe('harness');
    expect((await evaluateHarnessChatMode(env, 'invalid', userId)).variation).toBe('legacy');
    expect(env.FLAGS.getStringDetails).not.toHaveBeenCalled();
  });
});

describe('runner and asset routing', () => {
  it('serves an independent same-origin auth callback without booting protected Harness assets', async () => {
    const assets = vi.fn();
    const response = await worker.fetch(new Request('https://chat.preview.singulancelabs.com/auth/callback'), {
      ASSETS: { fetch: assets },
    } as unknown as Env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html).toContain("location.hash.slice(1)");
    expect(html).toContain("history.replaceState(null,'','/auth/callback')");
    expect(html).toContain("fetch('/api/hivemind/embed/exchange'");
    expect(html).toContain("location.replace('/')");
    expect(assets).not.toHaveBeenCalled();
  });

  it('proxies API paths to the configured private runner origin', async () => {
    const fetchMock = vi.fn(async (request: Request) => Response.json({ target: request.url }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { RUNNER_ORIGIN: 'https://private-runner.example' } as Env;
    const response = await worker.fetch(new Request('https://chat.singulancelabs.com/api/remote.mux?session=1'), env);
    expect((await response.json()).target).toBe('https://private-runner.example/api/remote.mux?session=1');
    vi.unstubAllGlobals();
  });

  it('preserves WebSocket upgrade headers for /api/remote.mux', async () => {
    const received: Array<{ url: string; upgrade: string | null; connection: string | null; origin: string | null; forwardedHost: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
      received.push({
        url: request.url,
        upgrade: request.headers.get('upgrade'),
        connection: request.headers.get('connection'),
        origin: request.headers.get('origin'),
        forwardedHost: request.headers.get('x-forwarded-host'),
      });
      return new Response(null, { status: 200, headers: { upgrade: 'websocket', connection: 'Upgrade' } });
    }));
    const env = { RUNNER_ORIGIN: 'https://private-runner.example' } as Env;
    const response = await worker.fetch(new Request('https://next.preview.singulancelabs.com/api/remote.mux', {
      headers: {
        origin: 'https://next.preview.singulancelabs.com',
        upgrade: 'websocket',
        connection: 'Upgrade',
      },
    }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('upgrade')).toBe('websocket');
    expect(received[0]).toEqual({
      url: 'https://private-runner.example/api/remote.mux',
      upgrade: 'websocket',
      connection: 'Upgrade',
      origin: 'https://next.preview.singulancelabs.com',
      forwardedHost: 'next.preview.singulancelabs.com',
    });
    vi.unstubAllGlobals();
  });

  it('keeps next.preview origin on session establish so the cookie is same-origin', async () => {
    const received: Array<{ origin: string | null; forwardedHost: string | null; path: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
      received.push({
        origin: request.headers.get('origin'),
        forwardedHost: request.headers.get('x-forwarded-host'),
        path: new URL(request.url).pathname,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'set-cookie': 'hm=1; Path=/; Secure; HttpOnly; SameSite=None' },
      });
    }));
    const env = { RUNNER_ORIGIN: 'https://private-runner.example' } as Env;
    const response = await worker.fetch(new Request('https://next.preview.singulancelabs.com/api/hivemind/session/establish', {
      method: 'POST',
      headers: {
        origin: 'https://next.preview.singulancelabs.com',
        'content-type': 'application/json',
      },
      body: '{}',
    }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Path=/');
    expect(received[0]).toEqual({
      origin: 'https://next.preview.singulancelabs.com',
      forwardedHost: 'next.preview.singulancelabs.com',
      path: '/api/hivemind/session/establish',
    });
    vi.unstubAllGlobals();
  });

  it('keeps parent navigation origin for both exchange transports', async () => {
    const received: Array<{ url: string; host: string | null; origin: string | null; contentType: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
      received.push({
        url: request.url,
        host: request.headers.get('host'),
        origin: request.headers.get('origin'),
        contentType: request.headers.get('content-type'),
      });
      return new Response(null, { status: 303, headers: { location: '/' } });
    }));
    const env = { RUNNER_ORIGIN: 'https://private-runner.example' } as Env;
    const exchangeUrl = 'https://next.preview.singulancelabs.com/api/hivemind/embed/exchange';

    await worker.fetch(new Request(exchangeUrl, {
      method: 'POST',
      headers: {
        origin: 'https://next.preview.singulancelabs.com',
        'content-type': 'application/x-www-form-urlencoded',
      },
    }), env);
    await worker.fetch(new Request(exchangeUrl, {
      method: 'POST',
      headers: {
        origin: 'https://next.preview.singulancelabs.com',
        'content-type': 'application/json',
      },
    }), env);

    expect(received).toEqual([
      {
        url: 'https://private-runner.example/api/hivemind/embed/exchange',
        host: null,
        origin: 'https://next.preview.singulancelabs.com',
        contentType: 'application/x-www-form-urlencoded',
      },
      {
        url: 'https://private-runner.example/api/hivemind/embed/exchange',
        host: null,
        origin: 'https://next.preview.singulancelabs.com',
        contentType: 'application/json',
      },
    ]);
    vi.unstubAllGlobals();
  });

  it('preserves browser and foreign origins on native unary RPCs', async () => {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ ok: true });
    }));
    try {
      for (const origin of ['https://next.preview.singulancelabs.com', 'https://foreign.example']) {
        await worker.fetch(new Request('https://next.preview.singulancelabs.com/api/session/list', {
          method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
        }), { RUNNER_ORIGIN: 'https://private-runner.example' } as Env);
        const forwarded = requests.at(-1)!;
        expect(forwarded.url).toBe('https://private-runner.example/api/session/list');
        expect(forwarded.headers.get('origin')).toBe(origin);
        expect(forwarded.headers.get('x-forwarded-host')).toBe('next.preview.singulancelabs.com');
      }
    } finally { vi.unstubAllGlobals(); }
  });

  it('adds an explicit frame ancestor policy to static assets', async () => {
    const env = {
      HIVE_HARNESS_PARENT_ORIGINS: 'https://next.singulancelabs.com,https://admin.singulancelabs.com',
      ASSETS: { fetch: vi.fn(async () => new Response('app', { headers: { 'content-type': 'application/javascript' } })) },
    } as unknown as Env;
    const response = await worker.fetch(new Request('https://chat.singulancelabs.com/assets/app.js'), env);
    expect(response.headers.get('content-security-policy')).toContain('frame-ancestors https://next.singulancelabs.com https://admin.singulancelabs.com');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves the document from assets and injects the authenticated runner boot table', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ version: 1, injections: [
      { kind: 'global', name: '__DSH_BOOT__', value: { plugins: [] } },
    ] })));
    const env = {
      RUNNER_ORIGIN: 'https://private-runner.example',
      HIVE_HARNESS_PARENT_ORIGINS: 'https://next.singulancelabs.com',
      ASSETS: { fetch: vi.fn(async () => new Response('<html><head></head><body><div id="root"></div></body></html>', {
        headers: { 'content-type': 'text/html' },
      })) },
    } as unknown as Env;
    const response = await worker.fetch(new Request('https://chat.singulancelabs.com/', {
      headers: { cookie: '__Host-dsh=principal' },
    }), env);
    const html = await response.text();
    expect(html).toContain('globalThis["__DSH_BOOT__"]');
    expect(html).toContain('__DSH_BOOT_READY__');
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('accepts the current unversioned runner boot envelope without serving a raw shell', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, injections: [
      { kind: 'script', placement: 'head', text: 'window.__ModuleLoader__={create(){}}' },
      { kind: 'global', name: '__DSH_BOOT__', value: { entries: [] } },
    ] })));
    const env = {
      RUNNER_ORIGIN: 'https://private-runner.example',
      HIVE_HARNESS_PARENT_ORIGINS: 'https://next.preview.singulancelabs.com',
      ASSETS: { fetch: vi.fn(async () => new Response('<html><head></head><body><script type="module" src="/assets/harness-shell.js"></script></body></html>', {
        headers: { 'content-type': 'text/html' },
      })) },
    } as unknown as Env;

    const response = await worker.fetch(new Request('https://next.preview.singulancelabs.com/hivemind/app/overview'), env);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html.indexOf('window.__ModuleLoader__')).toBeLessThan(html.indexOf('harness-shell.js'));
    expect(html).toContain('globalThis["__DSH_BOOT__"]');
    vi.unstubAllGlobals();
  });
});

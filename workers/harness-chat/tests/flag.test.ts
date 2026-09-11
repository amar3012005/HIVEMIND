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

  it('keeps parent navigation origin and uses private same-origin JSON transport', async () => {
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
        origin: 'https://private-runner.example',
        contentType: 'application/json',
      },
    ]);
    vi.unstubAllGlobals();
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
      { kind: 'script', placement: 'head', text: 'globalThis.__ModuleLoader__={create(){}}' },
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

  it('rejects a runner boot table that cannot install the native module loader', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ version: 1, injections: [
      { kind: 'global', name: '__DSH_BOOT__', value: { plugins: [] } },
    ] })));
    const env = {
      RUNNER_ORIGIN: 'https://private-runner.example',
      HIVE_HARNESS_PARENT_ORIGINS: 'https://next.preview.singulancelabs.com',
      ASSETS: { fetch: vi.fn(async () => new Response('<html><head></head><body></body></html>', {
        headers: { 'content-type': 'text/html' },
      })) },
    } as unknown as Env;

    const response = await worker.fetch(new Request('https://chat.preview.singulancelabs.com/'), env);

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('HIVE-MIND boot unavailable');
    vi.unstubAllGlobals();
  });
});

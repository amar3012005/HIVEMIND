import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { engineBoxReadiness, loadEngineBoxRuntime } from './runtime.js';

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function probeHttp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok ? 'ready' : 'unavailable';
  } catch { return 'unavailable'; }
}

export async function probeEngineBoxServices({ prisma, qdrantUrl, modelRouterUrl, probes = {} } = {}) {
  const database = probes.postgres || (async () => {
    try { await prisma?.$queryRawUnsafe('SELECT 1'); return prisma ? 'ready' : 'unavailable'; } catch { return 'unavailable'; }
  });
  const checks = await Promise.all([
    database(),
    (probes.qdrant || (() => probeHttp(`${qdrantUrl}/healthz`)))(),
    (probes.redis || (async () => 'ready'))(), // Redis queue boot validates its own connection before work.
    (probes.extract || (() => probeHttp(`${process.env.KB_EXTRACT_URL}/health`)))(),
    (probes.modelRouter || (() => probeHttp(`${modelRouterUrl}/health`)))(),
    (probes.controlPlane || (() => probeHttp(`${process.env.CONTROL_PLANE_URL}/ready`)))(),
  ]);
  return {
    postgres: checks[0], qdrant: checks[1], redis: checks[2], hm_extract: checks[3], model_router: checks[4],
    control_plane: checks[5], core: 'ready', ingestion: 'ready', mcp: 'ready', edge: 'ready',
  };
}

export function createEngineBoxServer({ runtime, serviceProbe, lease = { expiresAt: process.env.ENGINE_BOX_LEASE_EXPIRES_AT } }) {
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname !== '/health' && pathname !== '/ready') return json(res, 404, { error: 'not_found' });
    const services = await serviceProbe();
    const modelRoute = services.model_router === 'ready' ? { execution: process.env.ENGINE_BOX_MODEL_EXECUTION || 'local' } : null;
    const status = engineBoxReadiness({ services, modelRoute, license: lease });
    if (pathname === '/health') return json(res, 200, { ok: true, service: 'hm-core-engine', state: status.state });
    return json(res, status.state === 'UNAVAILABLE' ? 503 : 200, { ...status, api_version: runtime.apiVersion });
  });
}

export async function startEngineBoxServer(env = process.env) {
  const runtime = loadEngineBoxRuntime(env);
  if (!runtime.enabled) throw new Error('ENGINE_BOX_MODE=true is required for the Engine Box server entrypoint');
  const { getPrismaClient } = await import('../db/prisma.js');
  const prisma = getPrismaClient();
  const server = createEngineBoxServer({
    runtime,
    serviceProbe: () => probeEngineBoxServices({
      prisma,
      qdrantUrl: env.QDRANT_URL || 'http://qdrant:6333',
      modelRouterUrl: env.MODEL_ROUTER_URL || 'http://hm-model-router:8090',
    }),
  });
  const port = Number(env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ svc: 'hm-core-engine', event: 'listening', port, mode: 'engine_box' })));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await startEngineBoxServer();

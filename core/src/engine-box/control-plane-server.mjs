import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadEngineBoxRuntime } from './runtime.js';

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/**
 * Engine Box deliberately does not boot src/control-plane-server.js. That
 * hosted entrypoint imports onboarding, connector, employee, and workflow
 * machinery which cannot exist in a content-local appliance. This small
 * process is the local authority seam; feature routes are added here only
 * after their RBAC and tenancy contract is certified.
 */
export function createEngineBoxControlPlane({ runtime, postgresProbe }) {
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname !== '/health' && pathname !== '/ready') return send(res, 404, { error: 'not_found' });
    const postgres = await postgresProbe();
    const ready = postgres === 'ready';
    if (pathname === '/health') return send(res, 200, { ok: true, service: 'hm-control-plane', state: ready ? 'READY' : 'UNAVAILABLE' });
    return send(res, ready ? 200 : 503, {
      state: ready ? 'READY' : 'UNAVAILABLE',
      api_version: runtime.apiVersion,
      capabilities: runtime.capabilities.filter((name) => ['identity', 'rbac', 'api_keys', 'licence', 'admin', 'audit'].includes(name)),
    });
  });
}

export async function startEngineBoxControlPlane(env = process.env) {
  const runtime = loadEngineBoxRuntime(env);
  if (!runtime.enabled) throw new Error('ENGINE_BOX_MODE=true is required for the Engine Box Control Plane');
  const { getPrismaClient } = await import('../db/prisma.js');
  const prisma = getPrismaClient();
  const postgresProbe = async () => {
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      return 'ready';
    } catch {
      return 'unavailable';
    }
  };
  const server = createEngineBoxControlPlane({ runtime, postgresProbe });
  const port = Number(env.CONTROL_PLANE_PORT || 3001);
  server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ svc: 'hm-control-plane', event: 'listening', port, mode: 'engine_box' })));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await startEngineBoxControlPlane();

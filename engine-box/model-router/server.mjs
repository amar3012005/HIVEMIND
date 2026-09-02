import http from 'node:http';
import fs from 'node:fs';
import { selectModelRoute, validateModelCatalog, verifySignedCatalog } from '../lib/model-catalog.mjs';
import { readSetupRecord } from '../lib/local-state.mjs';

const port = Number(process.env.MODEL_ROUTER_PORT || 8090);
const remoteInferenceAllowed = process.env.ENGINE_BOX_REMOTE_INFERENCE_ALLOWED === 'true';

function catalogState(env = process.env) {
  const catalogPath = env.MODEL_CATALOG_PATH || '/etc/hivemind/model-catalog.json';
  const signaturePath = env.MODEL_CATALOG_SIGNATURE_PATH || '/etc/hivemind/model-catalog.sig';
  const publicKeyPath = env.RELEASE_PUBLIC_KEY_PATH || '/etc/hivemind/release.pub';
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  validateModelCatalog(catalog);
  const signature = fs.readFileSync(signaturePath, 'utf8').trim();
  const publicKey = fs.readFileSync(publicKeyPath, 'utf8');
  if (!verifySignedCatalog({ catalog, signature, publicKey })) throw new Error('model catalog signature is invalid');
  return catalog;
}

function response(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readJson(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > maxBytes) throw new Error('model request exceeds maximum size'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function endpoint(baseUrl, suffix) { return `${String(baseUrl).replace(/\/$/, '')}/${String(suffix).replace(/^\//, '')}`; }
function headers(route) { return { 'content-type': 'application/json', ...(route.api_key ? { authorization: `Bearer ${route.api_key}` } : {}) }; }
function publicRoute(route) { const { api_key, ...safe } = route; return safe; }

function healthEndpoint(route) {
  const url = new URL(route.base_url);
  return new URL(route.health_url || route.healthPath || '/health', url.origin).toString();
}

async function configuredRoute(capability, request = {}, env = process.env) {
  const selected = selectModelRoute(catalogState(env), capability, { routeId: request.route_id, consent: remoteInferenceAllowed });
  const setup = await readSetupRecord(env);
  const local = setup?.model_routes?.[capability];
  if (!local || selected.execution !== 'local') throw new Error(`no configured sovereign ${capability} route is available`);
  return { ...selected, ...local, routeId: selected.routeId, execution: selected.execution, catalogue_model: selected.model };
}

export async function inferModel(request, { env = process.env, fetchImpl = fetch } = {}) {
  const capability = String(request?.capability || '');
  if (!['embedding', 'rerank', 'chat'].includes(capability)) throw new Error('unsupported model capability');
  const route = await configuredRoute(capability, request, env);
  if (capability === 'embedding') {
    const input = Array.isArray(request.input) ? request.input : [request.input];
    if (!input.length || input.some((value) => typeof value !== 'string')) throw new Error('embedding input must be a non-empty string array');
    const result = await fetchImpl(endpoint(route.base_url, 'embeddings'), { method: 'POST', headers: headers(route), body: JSON.stringify({ model: route.model, input }) });
    if (!result.ok) throw new Error(`customer embedding route returned ${result.status}`);
    const body = await result.json(); const vectors = body?.data?.map((item) => item?.embedding);
    if (!Array.isArray(vectors) || vectors.length !== input.length || vectors.some((vector) => !Array.isArray(vector) || vector.length !== route.dimension)) throw new Error('customer embedding response violates configured dimension');
    return { route: publicRoute(route), vectors };
  }
  if (capability === 'rerank') {
    if (typeof request.query !== 'string' || !Array.isArray(request.documents)) throw new Error('rerank requires query and documents');
    const result = await fetchImpl(endpoint(route.base_url, 'rerank'), { method: 'POST', headers: headers(route), body: JSON.stringify({ model: route.model, query: request.query, documents: request.documents }) });
    if (!result.ok) throw new Error(`customer rerank route returned ${result.status}`);
    return { route: publicRoute(route), result: await result.json() };
  }
  if (!Array.isArray(request.messages)) throw new Error('chat requires messages');
  const result = await fetchImpl(endpoint(route.base_url, 'chat/completions'), { method: 'POST', headers: headers(route), body: JSON.stringify({ model: route.model, messages: request.messages, temperature: request.temperature ?? 0, stream: false }) });
  if (!result.ok) throw new Error(`customer chat route returned ${result.status}`);
  return { route: publicRoute(route), result: await result.json() };
}

/** Probe configured customer-local routes; container liveness alone is never readiness. */
export async function probeConfiguredRoutes({ env = process.env, fetchImpl = fetch } = {}) {
  return Promise.all(['embedding', 'rerank', 'chat'].map(async (capability) => {
    const route = await configuredRoute(capability, {}, env);
    const result = await fetchImpl(healthEndpoint(route), {
      method: 'GET',
      headers: route.api_key ? { authorization: `Bearer ${route.api_key}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (!result.ok) throw new Error(`${capability} model health returned ${result.status}`);
    return { capability, route: publicRoute(route) };
  }));
}

export function createModelRouterServer({ env = process.env, fetchImpl = fetch } = {}) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        const catalog = catalogState(env); const setup = await readSetupRecord(env).catch(() => null);
        return response(res, 200, { ok: true, catalog_version: catalog.catalogVersion, configured: !!setup?.model_routes, routes: catalog.routes.map(({ routeId, capability, execution }) => ({ routeId, capability, execution })) });
      }
      if (req.method === 'GET' && req.url === '/ready') {
        const routes = await probeConfiguredRoutes({ env, fetchImpl });
        return response(res, 200, { ok: true, state: 'READY', routes });
      }
      if (req.method === 'POST' && req.url === '/v1/select') {
        const request = await readJson(req);
        return response(res, 200, { route: publicRoute(await configuredRoute(request.capability, request, env)) });
      }
      if (req.method === 'POST' && req.url === '/v1/infer') return response(res, 200, await inferModel(await readJson(req), { env, fetchImpl }));
      return response(res, 404, { error: 'not_found' });
    } catch (error) { return response(res, 503, { error: 'model_router_unavailable', detail: error.message }); }
  });
}

export function startModelRouter(env = process.env) {
  const server = createModelRouterServer({ env });
  server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ svc: 'hm-model-router', event: 'ready', port })));
  return server;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) startModelRouter();

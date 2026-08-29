import http from 'node:http';
import fs from 'node:fs';
import { selectModelRoute, validateModelCatalog, verifySignedCatalog } from '../lib/model-catalog.mjs';

const catalogPath = process.env.MODEL_CATALOG_PATH || '/etc/hivemind/model-catalog.json';
const signaturePath = process.env.MODEL_CATALOG_SIGNATURE_PATH || '/etc/hivemind/model-catalog.sig';
const publicKeyPath = process.env.RELEASE_PUBLIC_KEY_PATH || '/etc/hivemind/release.pub';
const port = Number(process.env.MODEL_ROUTER_PORT || 8090);

function catalogState() {
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

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      const catalog = catalogState();
      return response(res, 200, { ok: true, catalog_version: catalog.catalogVersion, routes: catalog.routes.map(({ routeId, capability, execution }) => ({ routeId, capability, execution })) });
    }
    if (req.method === 'POST' && req.url === '/v1/select') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw || '{}');
      const route = selectModelRoute(catalogState(), request.capability, { routeId: request.route_id, consent: request.consent === true });
      return response(res, 200, { route });
    }
    return response(res, 404, { error: 'not found' });
  } catch (error) {
    return response(res, 503, { error: 'model_router_unavailable', detail: error.message });
  }
}).listen(port, '0.0.0.0', () => console.log(JSON.stringify({ svc: 'hm-model-router', event: 'ready', port })));

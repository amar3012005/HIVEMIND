'use strict';
// session.protocol.handle('https') handler: answers allowlisted GETs from the local bundle, else the network.
const policy = require('./screens-policy');

const MAX_STORE_BYTES = 8 * 1024 * 1024;

function localResponse(kind, rel, hit) {
  const type = kind === 'shell' ? 'text/html; charset=utf-8' : policy.contentTypeFor(rel);
  return new Response(hit.data, {
    status: 200,
    headers: {
      'content-type': type,
      'content-length': String(hit.data.length),
      'cache-control': kind === 'asset' ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-singulance-screens': hit.source,
    },
  });
}

/** passthrough(request) must fetch from the network with the same session, bypassing this handler. */
function createScreensHandler({ store, passthrough, log = () => {} }) {
  async function remember(host, rel, res) {
    const len = Number(res.headers.get('content-length') || 0);
    if (res.status !== 200 || res.headers.get('content-range') || len > MAX_STORE_BYTES) return;
    if ((res.headers.get('content-type') || '').toLowerCase().includes('text/html')) return; // SPA fallback for a missing file
    const buf = Buffer.from(await res.clone().arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_STORE_BYTES) return;
    store.writeCache(host, rel, buf);
  }

  return async function handle(request) {
    let c;
    try { c = policy.classifyScreenRequest({ url: request.url, method: request.method, headers: request.headers }); }
    catch { c = { kind: 'pass' }; /* unparseable request: leave it to the network */ }
    if (c.kind === 'pass') return passthrough(request);
    try {
      if (c.kind === 'shell') {
        const hit = store.readShell(c.host);
        return hit ? localResponse('shell', '', hit) : passthrough(request);
      }
      const hit = store.read(c.host, c.rel);
      if (hit) return localResponse(c.kind, c.rel, hit);
      const res = await passthrough(request);
      if (c.kind === 'asset') remember(c.host, c.rel, res).catch((err) => log('screens store failed', c.rel, err.message));
      return res;
    } catch (err) {
      log('screens handler fell back to network', err.message);
      return passthrough(request);
    }
  };
}

module.exports = { createScreensHandler };

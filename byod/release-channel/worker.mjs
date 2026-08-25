const RELEASE_ID = /^[a-zA-Z0-9._-]{7,80}$/;
const CHANNELS = new Set(['stable', 'canary']);

const headersFor = (contentType, immutable = false) => ({
  'content-type': contentType,
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache, no-store, must-revalidate',
});

async function objectResponse(bucket, key, request, contentType, immutable = false) {
  const object = await bucket.get(key);
  if (!object) return new Response('Not found\n', { status: 404 });
  const headers = new Headers(headersFor(contentType, immutable));
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

export default {
  async fetch(request, env) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed\n', { status: 405 });
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    if (path === '/memory-box') {
      return objectResponse(env.RELEASES, 'bootstrap/memory-box', request, 'text/x-shellscript; charset=utf-8');
    }
    if (path === '/memory-box/release.pub') {
      return objectResponse(env.RELEASES, 'bootstrap/release.pub', request, 'application/x-pem-file; charset=utf-8');
    }

    const channelMatch = path.match(/^\/memory-box\/releases\/(stable|canary)\/(release\.json|release\.sig)$/);
    if (channelMatch && CHANNELS.has(channelMatch[1])) {
      const pointer = await env.RELEASES.get(`channels/${channelMatch[1]}.json`);
      if (!pointer) return new Response('Release channel unavailable\n', { status: 503 });
      let release;
      try { release = (await pointer.json()).release; } catch { return new Response('Invalid release channel\n', { status: 503 }); }
      if (!RELEASE_ID.test(release || '')) return new Response('Invalid release channel\n', { status: 503 });
      const type = channelMatch[2] === 'release.json' ? 'application/json; charset=utf-8' : 'application/octet-stream';
      return objectResponse(env.RELEASES, `releases/${release}/${channelMatch[2]}`, request, type);
    }

    const immutableMatch = path.match(/^\/memory-box\/releases\/([a-zA-Z0-9._-]{7,80})\/(bundle\.tar\.gz|release\.json|release\.sig)$/);
    if (immutableMatch && RELEASE_ID.test(immutableMatch[1])) {
      const type = immutableMatch[2].endsWith('.json') ? 'application/json; charset=utf-8'
        : immutableMatch[2].endsWith('.sig') ? 'application/octet-stream' : 'application/gzip';
      return objectResponse(env.RELEASES, `releases/${immutableMatch[1]}/${immutableMatch[2]}`, request, type, true);
    }
    return new Response('Not found\n', { status: 404 });
  },
};

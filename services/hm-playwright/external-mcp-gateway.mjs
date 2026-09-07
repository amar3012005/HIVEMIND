import crypto from 'node:crypto';
import http from 'node:http';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS = 12;

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function externalClientId(req) {
  const value = String(req.headers['cf-access-client-id'] || 'unknown');
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

async function readBoundedBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function upstreamHeaders(headers, bodyLength, upstreamHost, upstreamPort) {
  const result = { ...headers, host: `${upstreamHost}:${upstreamPort}` };
  delete result.authorization;
  delete result.cookie;
  delete result['cf-access-client-secret'];
  delete result['cf-access-jwt-assertion'];
  delete result['cf-access-authenticated-user-email'];
  delete result['content-length'];
  if (bodyLength) result['content-length'] = String(bodyLength);
  return result;
}

export function isExternalMcpPath(value) {
  try {
    const pathname = new URL(value, 'http://localhost').pathname;
    return pathname === '/mcp' || pathname.startsWith('/mcp/');
  } catch {
    return false;
  }
}

export function createExternalMcpGateway({
  enabled,
  token,
  upstreamHost = '127.0.0.1',
  upstreamPort = 8931,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  logger = (event) => console.log(JSON.stringify(event)),
} = {}) {
  let active = 0;

  return async function externalMcpGateway(req, res) {
    if (!isExternalMcpPath(req.url)) return send(res, 404, { error: 'not_found' });
    if (!enabled) return send(res, 404, { error: 'not_found' });
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!secureEqual(bearer, token)) return send(res, 401, { error: 'unauthorized' });
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (!Number.isFinite(declaredLength) || declaredLength > maxBodyBytes) {
      return send(res, 413, { error: 'request_too_large' });
    }
    if (active >= maxConnections) return send(res, 429, { error: 'too_many_mcp_connections' });

    active += 1;
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const client = externalClientId(req);
    logger({ event: 'playwright.mcp.started', request_id: requestId, client });
    try {
      const body = await readBoundedBody(req, maxBodyBytes);
      await new Promise((resolve) => {
        const upstream = http.request({
          host: upstreamHost,
          port: upstreamPort,
          method: req.method,
          path: req.url,
          headers: upstreamHeaders(req.headers, body.length, upstreamHost, upstreamPort),
        }, (upstreamResponse) => {
          res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
          upstreamResponse.pipe(res);
          upstreamResponse.once('end', resolve);
          upstreamResponse.once('error', () => {
            if (!res.headersSent) send(res, 502, { error: 'mcp_upstream_failed' });
            else res.destroy();
            resolve();
          });
        });
        upstream.setTimeout(15 * 60_000, () => upstream.destroy(new Error('mcp_upstream_timeout')));
        upstream.once('error', () => {
          if (!res.headersSent) send(res, 502, { error: 'mcp_upstream_unavailable' });
          else res.destroy();
          resolve();
        });
        if (body.length) upstream.write(body);
        upstream.end();
      });
      logger({ event: 'playwright.mcp.completed', request_id: requestId, client, duration_ms: Date.now() - startedAt });
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 502, { error: error.status === 413 ? 'request_too_large' : 'mcp_proxy_failed' });
      else res.destroy();
      logger({ event: 'playwright.mcp.failed', request_id: requestId, client, duration_ms: Date.now() - startedAt });
    } finally {
      active = Math.max(0, active - 1);
    }
  };
}

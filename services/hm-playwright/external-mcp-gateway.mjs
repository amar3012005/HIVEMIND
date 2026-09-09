import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

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

function upstreamHeaders(headers, bodyLength, upstreamHost) {
  // @playwright/mcp validates the Host header against --allowed-hosts without
  // normalizing ports. Forward only the loopback hostname; the TCP port is
  // already fixed independently on the request socket.
  const result = { ...headers, host: upstreamHost };
  delete result.authorization;
  delete result.cookie;
  delete result['cf-access-client-secret'];
  delete result['cf-access-jwt-assertion'];
  delete result['cf-access-authenticated-user-email'];
  delete result['content-length'];
  if (bodyLength) result['content-length'] = String(bodyLength);
  return result;
}

function parseUpstreamRpc(body) {
  const text = body.toString('utf8');
  const data = text.split(/\r?\n/).find((line) => line.startsWith('data:'));
  return JSON.parse(data ? data.slice(5).trim() : text);
}

/**
 * The stock Playwright MCP server persists screenshots beside its process and
 * returns a relative Markdown link.  That link is useful to an interactive
 * terminal, but it is neither durable nor renderable by a remote MCP client.
 *
 * Turn only a certified screenshot result into the standard MCP image block.
 * The path is deliberately constrained to a single relative filename beneath
 * the configured artifact root: an upstream tool response must never become
 * filesystem authority for the gateway.
 */
async function projectScreenshotAttachment(rpc, artifactRoot) {
  const content = rpc?.result?.content;
  if (!Array.isArray(content)) return rpc;
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  // A recoverable 502/503/504 rotates the Harness MCP client generation. The
  // replacement Playwright session begins at about:blank, so a later capture
  // can be technically successful while containing no requested page. Refuse
  // that artifact at the browser-provider boundary and give the autonomous
  // runtime the compact recovery contract; native Harness Tool errors and
  // receipts remain unchanged.
  if (/\bPage URL:\s*about:blank\b/i.test(text)) {
    return {
      ...rpc,
      result: {
        content: [{
          type: 'text',
          text: 'browser_session_reset: the recovered browser is at about:blank, so no screenshot was admitted. Call browser_capabilities with the original intent and restart its ordered plan from browser_navigate.',
        }],
        isError: true,
        structuredContent: {
          code: 'browser_session_reset',
          retryable: true,
          restart_from: 'browser_capabilities',
        },
      },
    };
  }
  const link = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.match(/\[[^\]]+\]\(\.\/([^/()\\]+\.(?:png|jpe?g|webp|gif))\)/i)?.[1])
    .find(Boolean);
  if (link === undefined) return rpc;

  const resolvedRoot = path.resolve(artifactRoot);
  const artifactPath = path.resolve(resolvedRoot, link);
  if (!artifactPath.startsWith(`${resolvedRoot}${path.sep}`)) return rpc;

  let data;
  try {
    data = await fs.readFile(artifactPath);
  } catch {
    return rpc;
  }
  // Keep the proxy's bounded-response contract even if an upstream tool is
  // misconfigured to write a huge artifact.
  if (data.length === 0 || data.length > 5 * 1024 * 1024) return rpc;
  const extension = path.extname(link).toLowerCase();
  const mimeType = extension === '.png'
    ? 'image/png'
    : extension === '.webp'
      ? 'image/webp'
      : extension === '.gif'
        ? 'image/gif'
        : 'image/jpeg';
  return {
    ...rpc,
    result: {
      ...rpc.result,
      content: [...content, { type: 'image', data: data.toString('base64'), mimeType }],
    },
  };
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
  artifactRoot = process.cwd(),
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
      // The gateway deliberately does not decide which Playwright action the
      // model should take. It proxies the official server's schema and actions
      // unchanged; the Harness progressive tool layer owns discovery. We only
      // identify a screenshot call so its generated artifact can become a
      // standard MCP image block for native Harness rendering.
      let screenshotExecution = false;
      if (body.length) {
        try {
          const request = JSON.parse(body.toString('utf8'));
          screenshotExecution = request?.method === 'tools/call'
            && request?.params?.name === 'browser_take_screenshot';
        } catch (error) {
          send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid_json' } });
          return;
        }
      }
      await new Promise((resolve) => {
        const upstream = http.request({
          host: upstreamHost,
          port: upstreamPort,
          method: req.method,
          path: req.url,
          headers: upstreamHeaders(req.headers, body.length, upstreamHost),
        }, (upstreamResponse) => {
          if (screenshotExecution) {
            const chunks = [];
            upstreamResponse.on('data', (chunk) => chunks.push(chunk));
            upstreamResponse.once('end', async () => {
              try {
                const upstreamRpc = parseUpstreamRpc(Buffer.concat(chunks));
                const response = await projectScreenshotAttachment(upstreamRpc, artifactRoot);
                send(res, 200, response);
              } catch {
                send(res, 502, { error: 'mcp_upstream_invalid_response' });
              }
              resolve();
            });
            upstreamResponse.once('error', () => {
              if (!res.headersSent) send(res, 502, { error: 'mcp_upstream_failed' });
              else res.destroy();
              resolve();
            });
            return;
          }
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

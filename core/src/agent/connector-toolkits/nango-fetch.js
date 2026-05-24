/**
 * Shared helper — fetch a Nango-managed bearer token for a user×provider
 * pair, then proxy a REST call to the provider API. Used by gmail/gdocs/
 * gemini tool groups so each tool stays tiny (no per-tool auth plumbing).
 *
 * Tokens come from Nango's connections store; Nango handles refresh.
 * If the user has no active connection the call throws with a clear
 * "not connected" error which the agent surfaces to the user.
 */

import { getConnectionId, fetchBearerFromNango } from '../../connectors/mcp/nango-service.js';

const _bearerCache = new Map();  // key=`${userId}:${providerKey}`, value={ token, expires }
const BEARER_TTL_MS = 4 * 60 * 1000; // 4 min — comfortably below typical 5-min OAuth refresh window

export async function getNangoBearer({ userId, orgId, providerKey, prisma }) {
  const cacheKey = `${userId}:${providerKey}`;
  const cached = _bearerCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.token;
  }
  const connectionId = await getConnectionId({ userId, orgId, providerKey }, { db: prisma });
  if (!connectionId) {
    throw new Error(`not_connected:${providerKey}`);
  }
  const token = await fetchBearerFromNango(providerKey, connectionId);
  _bearerCache.set(cacheKey, { token, expires: Date.now() + BEARER_TTL_MS });
  return token;
}

/**
 * Proxy a REST call to a provider API using a Nango-managed bearer.
 *
 * @param {Object} args
 * @param {string} args.providerKey   Nango provider config key (google-mail, google-docs, ...)
 * @param {string} args.url           absolute URL
 * @param {string} [args.method='GET']
 * @param {Object} [args.headers]
 * @param {any}    [args.body]        JSON-stringified automatically when object
 * @param {Object} args.ctx           { userId, orgId, prisma }
 */
export async function nangoProxyFetch({ providerKey, url, method = 'GET', headers = {}, body, ctx }) {
  const bearer = await getNangoBearer({
    userId: ctx.userId, orgId: ctx.orgId, providerKey, prisma: ctx.prisma,
  });
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      ...headers,
    },
  };
  if (body !== undefined && body !== null) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const txt = await res.text();
  let json;
  try { json = txt ? JSON.parse(txt) : {}; } catch { json = { _raw: txt }; }
  if (!res.ok) {
    const err = new Error(`${providerKey} ${method} ${res.status}: ${(json?.error?.message || txt || '').slice(0, 200)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

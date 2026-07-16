import crypto from 'crypto';
import { getInternalApiKey } from '../security/internal-auth.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildInternalHeaders({ userId, orgId, headers = {}, allowDevFallback } = {}) {
  return {
    'X-API-Key': getInternalApiKey({ allowDevFallback }),
    'X-Request-Id': headers['X-Request-Id'] || headers['x-request-id'] || crypto.randomUUID(),
    ...(userId ? { 'X-HM-User-Id': userId } : {}),
    ...(orgId ? { 'X-HM-Org-Id': orgId } : {}),
    ...headers,
  };
}

export async function internalFetch(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 90_000,
    service = 'internal',
    userId,
    orgId,
    rawBody = false,
    allowGetRetry = method === 'GET',
  } = options;

  const finalHeaders = buildInternalHeaders({ userId, orgId, headers, allowDevFallback: options.allowDevFallback });
  const request = {
    method,
    headers: finalHeaders,
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
    if (rawBody) {
      request.body = body;
    } else if (typeof body === 'string' || body instanceof Buffer) {
      request.body = body;
    } else {
      request.body = JSON.stringify(body);
      if (!finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
    }
  }

  try {
    return await fetch(url, request);
  } catch (error) {
    if (!allowGetRetry) throw error;
    await sleep(500);
    return fetch(url, { ...request, signal: AbortSignal.timeout(timeoutMs) });
  }
}

import crypto from 'crypto';
import { getInternalApiKey } from '../security/internal-auth.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectionWasNeverEstablished(error) {
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
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
    retryOnConnectFailure = false,
    connectRetryDelaysMs = [200, 400, 800, 1200, 1600],
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

  const delays = retryOnConnectFailure && method !== 'GET' && method !== 'HEAD'
    ? connectRetryDelaysMs
    : (allowGetRetry ? [500] : []);
  let attempt = 0;
  while (true) {
    try {
      return await fetch(url, { ...request, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const mayRetry = attempt < delays.length && (
        allowGetRetry || (retryOnConnectFailure && connectionWasNeverEstablished(error))
      );
      if (!mayRetry) throw error;
      await sleep(delays[attempt]);
      attempt += 1;
    }
  }
}

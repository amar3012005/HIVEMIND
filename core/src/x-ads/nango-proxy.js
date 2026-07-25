const NANGO_URL = process.env.NANGO_URL || 'http://nango:3003';
const NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY || '';

export class ProviderError extends Error {
  constructor(message, { status = 502, code = 'provider_error', providerStatus = null, details = null, rateReset = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.providerStatus = providerStatus;
    this.details = details;
    this.rateReset = rateReset;
  }
}

function safeMessage(payload, fallback) {
  const first = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  return String(first?.message || first?.detail || first?.code || payload?.error_description || payload?.error || fallback).slice(0, 500);
}

export async function nangoProxy({ providerKey, connectionId, baseUrl, path, method = 'GET', body, contentType = 'application/json', timeoutMs = 30_000 }) {
  if (!NANGO_SECRET_KEY) throw new ProviderError('Nango is not configured', { status: 503, code: 'nango_unavailable' });
  const targetPath = String(path || '').startsWith('/') ? path : `/${path}`;
  const headers = {
    Authorization: `Bearer ${NANGO_SECRET_KEY}`,
    'Provider-Config-Key': providerKey,
    'Connection-Id': connectionId,
    'Base-Url-Override': baseUrl,
    Retries: method === 'GET' ? '2' : '0',
  };
  if (body !== undefined) headers['Content-Type'] = contentType;
  let response;
  try {
    response = await fetch(`${NANGO_URL}/proxy${targetPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : (contentType === 'application/json' ? JSON.stringify(body) : body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ProviderError(error?.name === 'TimeoutError' ? 'X request timed out; state requires reconciliation' : 'Could not reach X', {
      status: 502, code: error?.name === 'TimeoutError' ? 'ambiguous_timeout' : 'provider_unreachable',
    });
  }
  const text = await response.text().catch(() => '');
  let payload = null;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? response.status : (response.status === 429 ? 429 : 502);
    throw new ProviderError(safeMessage(payload, `X returned ${response.status}`), {
      status, code: response.status === 429 ? 'rate_limited' : (response.status === 401 ? 'reauth_required' : 'x_api_error'),
      providerStatus: response.status, details: payload, rateReset: response.headers.get('x-rate-limit-reset'),
    });
  }
  return { data: payload, headers: Object.fromEntries([...response.headers.entries()].filter(([key]) => key.startsWith('x-rate-limit') || key.startsWith('x-account-rate-limit'))) };
}

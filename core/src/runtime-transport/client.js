import { Agent, fetch as undiciFetch } from 'undici';

const DEFAULT_CONNECTIONS = Math.max(1, Number(process.env.HQ_RUNTIME_HTTP_CONNECTIONS || 8));
const DEFAULT_KEEP_ALIVE_MS = Math.max(1_000, Number(process.env.HQ_RUNTIME_HTTP_KEEP_ALIVE_MS || 60_000));
const DEFAULT_KEEP_ALIVE_MAX_MS = Math.max(DEFAULT_KEEP_ALIVE_MS, Number(process.env.HQ_RUNTIME_HTTP_KEEP_ALIVE_MAX_MS || 300_000));
const DEFAULT_HEADERS_TIMEOUT_MS = Math.max(1_000, Number(process.env.HQ_RUNTIME_HTTP_HEADERS_TIMEOUT_MS || 30_000));
const DEFAULT_BODY_TIMEOUT_MS = Math.max(DEFAULT_HEADERS_TIMEOUT_MS, Number(process.env.HQ_RUNTIME_HTTP_BODY_TIMEOUT_MS || 600_000));
const DEFAULT_IDLE_WARMUP_MS = Math.max(10_000, Number(process.env.HQ_RUNTIME_HTTP_IDLE_WARMUP_MS || 300_000));

const origins = new Map();

function errorCode(error) {
  return String(error?.code || error?.cause?.code || error?.name || 'RUNTIME_TRANSPORT_ERROR').toUpperCase();
}

export function employeesSidecarUrl() {
  return process.env.EMPLOYEES_SIDECAR_URL || process.env.HIVEMIND_EMPLOYEES_URL || 'http://hm-employees:8060';
}

export function classifyRuntimeTransportOutcome({ status = null, error = null, malformed = false } = {}) {
  if (error || malformed) {
    return {
      classification: 'uncertain_transport',
      status: status == null ? null : Number(status),
      code: malformed ? 'MALFORMED_SUCCESS_RESPONSE' : errorCode(error),
      retryable: true,
      reconciliation_required: true,
    };
  }
  const code = Number(status || 0);
  const transient = code === 408 || code === 429 || code >= 500;
  return {
    classification: transient ? 'transient_response' : 'deterministic_response',
    status: code || null,
    code: code ? `HTTP_${code}` : 'HTTP_RESPONSE',
    retryable: transient,
    reconciliation_required: transient,
  };
}

export class RuntimeTransportError extends Error {
  constructor(message, outcome, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RuntimeTransportError';
    Object.assign(this, outcome);
    this.ambiguous = outcome?.classification === 'uncertain_transport';
  }
}

function stateFor(origin) {
  let state = origins.get(origin);
  if (state) return state;
  state = {
    dispatcher: new Agent({
      connections: DEFAULT_CONNECTIONS,
      keepAliveTimeout: DEFAULT_KEEP_ALIVE_MS,
      keepAliveMaxTimeout: DEFAULT_KEEP_ALIVE_MAX_MS,
      headersTimeout: DEFAULT_HEADERS_TIMEOUT_MS,
      bodyTimeout: DEFAULT_BODY_TIMEOUT_MS,
    }),
    lastUsedAt: 0,
    warmup: null,
  };
  origins.set(origin, state);
  return state;
}

async function rawFetch(url, options = {}) {
  const target = new URL(url);
  const state = stateFor(target.origin);
  state.lastUsedAt = Date.now();
  return undiciFetch(target, { ...options, dispatcher: state.dispatcher });
}

export async function warmRuntimeOrigin(baseUrl = employeesSidecarUrl(), { force = false } = {}) {
  const target = new URL('/health', `${String(baseUrl).replace(/\/$/, '')}/`);
  const state = stateFor(target.origin);
  if (!force && state.lastUsedAt && Date.now() - state.lastUsedAt < DEFAULT_IDLE_WARMUP_MS) {
    return { warmed: false, reason: 'origin_recently_used', origin: target.origin };
  }
  if (state.warmup) return state.warmup;
  state.warmup = (async () => {
    try {
      const response = await rawFetch(target, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(DEFAULT_HEADERS_TIMEOUT_MS),
      });
      await response.arrayBuffer();
      return { warmed: response.ok, status: response.status, origin: target.origin };
    } finally {
      state.warmup = null;
    }
  })();
  return state.warmup;
}

export async function runtimeRequestJson(url, {
  method = 'GET', headers = {}, body = undefined, timeoutMs = DEFAULT_BODY_TIMEOUT_MS,
  warmAfterIdle = true,
} = {}) {
  const target = new URL(url);
  const state = stateFor(target.origin);
  if (warmAfterIdle && target.pathname !== '/health'
      && (!state.lastUsedAt || Date.now() - state.lastUsedAt >= DEFAULT_IDLE_WARMUP_MS)) {
    await warmRuntimeOrigin(target.origin).catch(() => {});
  }
  let response;
  try {
    response = await rawFetch(target, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(Math.max(1_000, Number(timeoutMs) || DEFAULT_BODY_TIMEOUT_MS)),
    });
  } catch (error) {
    const outcome = classifyRuntimeTransportOutcome({ error });
    throw new RuntimeTransportError(`runtime_transport_${outcome.code.toLowerCase()}`, outcome, error);
  }
  const text = await response.text().catch((error) => {
    const outcome = classifyRuntimeTransportOutcome({ status: response.status, error });
    throw new RuntimeTransportError('runtime_transport_response_read_uncertain', outcome, error);
  });
  let parsed = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      if (response.ok) {
        const outcome = classifyRuntimeTransportOutcome({ status: response.status, malformed: true });
        throw new RuntimeTransportError('runtime_transport_malformed_success_response', outcome, error);
      }
      parsed = { raw: text.slice(0, 4_000) };
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body: parsed,
    ...classifyRuntimeTransportOutcome({ status: response.status }),
  };
}

export function runtimeTransportStats() {
  return [...origins.entries()].map(([origin, state]) => ({
    origin,
    last_used_at: state.lastUsedAt || null,
    connections: DEFAULT_CONNECTIONS,
  }));
}

export async function closeRuntimeTransports() {
  const closing = [...origins.values()].map((state) => state.dispatcher.close());
  origins.clear();
  await Promise.allSettled(closing);
}

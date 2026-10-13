/** Purpose-separated model-only relay. Native OAuth credentials stay in DSH. */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { visibleBoundEmployee } from './open-dot-runtime-employee-operation.js';
import { lifecycleError } from './native-lifecycle.js';

const ORIGIN = 'http://harness-runner:3080';
const PATH = '/internal/hivemind/open-dot/model/stream';
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const FALLBACK_CODES = new Set(['RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'UNSUPPORTED_CONTENT']);
const ALLOWED = new Set(['organization_id','user_id','employee_id','dot_id','session_id','request_id',
  'provider','model','messages','tools','max_tokens','temperature','stop','reasoning_effort','stream',
  'parallel_tool_calls','stream_options','response_format','fallback_from']);

export function validateOpenDotModelRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !ALLOWED.has(key))) {
    lifecycleError('invalid_open_dot_model_request', 400);
  }
  const supportedModel = (raw.provider === 'openai-codex' && raw.model === 'gpt-6-luna')
    || (raw.provider === 'hivemind-global' && raw.model === 'default');
  if (!supportedModel
    || !Number.isSafeInteger(raw.max_tokens) || raw.max_tokens < 1 || raw.max_tokens > 8192
    || !Array.isArray(raw.messages) || raw.messages.length < 1 || raw.messages.length > 256
    || (raw.stream !== undefined && raw.stream !== true)
    || (raw.parallel_tool_calls !== undefined && raw.parallel_tool_calls !== false)
    || (raw.stream_options !== undefined && (!raw.stream_options || Array.isArray(raw.stream_options)
      || Object.keys(raw.stream_options).length !== 1 || raw.stream_options.include_usage !== true))
    || !/^[A-Za-z0-9_.:-]{1,180}$/.test(raw.session_id || '')
    || !/^[A-Za-z0-9_.:-]{1,180}$/.test(raw.request_id || '')) lifecycleError('invalid_open_dot_model_request', 400);
  if (raw.response_format !== undefined) {
    const format = raw.response_format;
    const schema = format?.json_schema;
    if (format?.type !== 'json_schema' || Object.keys(format).some(key => !['type', 'json_schema'].includes(key))
      || !schema || schema.strict !== true || !/^[A-Za-z0-9_-]{1,64}$/.test(schema.name || '')
      || !schema.schema || typeof schema.schema !== 'object' || Array.isArray(schema.schema)
      || Object.keys(schema).some(key => !['name', 'strict', 'schema', 'description'].includes(key)))
      lifecycleError('invalid_open_dot_model_request', 400);
  }
  const fallback = raw.fallback_from;
  if (raw.provider === 'openai-codex') {
    if (!fallback || Object.keys(fallback).some(key => !['provider', 'model', 'request_id', 'failure_code', 'output_started'].includes(key))
      || fallback.provider !== 'hivemind-global' || fallback.model !== 'default'
      || !/^[A-Za-z0-9_.:-]{1,180}$/.test(fallback.request_id || '') || fallback.request_id === raw.request_id
      || !['RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'UNSUPPORTED_CONTENT'].includes(fallback.failure_code)
      || fallback.output_started !== false)
      lifecycleError('invalid_open_dot_model_request', 400);
  } else if (fallback !== undefined) lifecycleError('invalid_open_dot_model_request', 400);
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_REQUEST_BYTES) lifecycleError('open_dot_model_request_too_large', 413);
  return raw;
}

export function mintOpenDotModelToken(body, secret, now = Date.now()) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) lifecycleError('open_dot_model_bridge_unavailable', 503);
  const at = Math.floor(now / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { iss: 'hivemind-control-plane', aud: 'hivemind-open-dot-model-broker',
    sub: body.user_id, org_id: body.organization_id, profile: 'hivemind-chat', variation: 'harness',
    employee_id: body.employee_id, dot_id: body.dot_id, session_id: body.session_id,
    request_id: body.request_id, provider: body.provider, model: body.model,
    ...(body.fallback_from ? { fallback_from: body.fallback_from } : {}),
    jti: randomUUID(), body_sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    iat: at, exp: at + 30 };
  const signed = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`;
}

/** Authenticate service separately at the route; revalidate canonical tenant binding here. */
export async function relayOpenDotModelStream(db, req, res, raw, { env = process.env, fetchImpl = fetch } = {}) {
  const input = validateOpenDotModelRequest(raw);
  await visibleBoundEmployee(db, input, { requireDispatch: false });
  const configured = env.HIVE_HARNESS_INTERNAL_ORIGIN;
  if (configured && ![ORIGIN, `${ORIGIN}/`].includes(configured)) lifecycleError('open_dot_model_bridge_unavailable', 503);
  const token = mintOpenDotModelToken(input, env.HIVE_HARNESS_RUNNER_SERVICE_SECRET);
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Model caller disconnected'));
  req.once?.('aborted', cancel); res.once?.('close', cancel);
  const timer = setTimeout(() => controller.abort(new Error('Model relay deadline exceeded')), 120_000);
  timer.unref?.();
  if (req.aborted || res.destroyed) cancel();
  let reader;
  try {
    controller.signal.throwIfAborted();
    const upstream = await fetchImpl(`${ORIGIN}${PATH}`, { method: 'POST', redirect: 'error',
      signal: controller.signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        accept: 'text/event-stream' }, body: JSON.stringify(input) });
    if (!upstream.ok) {
      let code = 'open_dot_model_upstream_unavailable';
      const errorReader = upstream.body?.getReader();
      if (errorReader) {
        try {
          const chunks = []; let bytes = 0;
          for (;;) {
            const item = await errorReader.read(); if (item.done) break;
            bytes += item.value.byteLength;
            if (bytes > 4096) break;
            chunks.push(Buffer.from(item.value));
          }
          if (bytes <= 4096) {
            const candidate = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error?.code;
            if (FALLBACK_CODES.has(candidate)) code = candidate;
          }
        } catch {} finally { await errorReader.cancel().catch(() => {}); errorReader.releaseLock(); }
      }
      res.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { code, message: code, type: 'hivemind_model_error' } }));
      return;
    }
    if (!upstream.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !upstream.body) {
      await upstream.body?.cancel(); lifecycleError('open_dot_model_invalid_response', 502);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    reader = upstream.body.getReader(); let size = 0;
    for (;;) {
      controller.signal.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); lifecycleError('open_dot_model_response_too_large', 502); }
      if (!res.write(Buffer.from(value))) await once(res, 'drain', { signal: controller.signal });
    }
    if (!res.destroyed) res.end();
  } finally {
    clearTimeout(timer); req.removeListener?.('aborted', cancel); res.removeListener?.('close', cancel);
    try { await reader?.cancel(); } catch {}
    reader?.releaseLock();
  }
}

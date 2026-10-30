/** Existing receiver calls this narrow native service seam. No connector subscriptions or model work here. */
import { createHmac, randomUUID } from 'node:crypto';
export function runtimeAttentionToken(row, operation, secret, now = Date.now()) {
  const at = Math.floor(now / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { iss: 'hivemind-control-plane', aud: 'hivemind-runtime-attention', sub: row.user_id,
    org_id: row.org_id, event_id: row.id, operation, iat: at, exp: at + 30, jti: randomUUID() };
  const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}
/** Hosts of Brain's chat runner, which is not a Runtime attention destination. */
let warnedBrainRunner = false;
const BRAIN_RUNNER_HOST = /^https?:\/\/(?:hivemind-)?harness-runner(?:-1)?[:/]/iu;
/**
 * Whether the attention routing environment can deliver, and why not. Checked once at server start so a wrong runner or a malformed
 * URL is named in the logs when Core boots instead of showing up later as events that stay pending.
 * @returns {{ok: true} | {ok: false, reason: 'not_configured' | 'secret_too_short' | 'invalid_url' | 'wrong_path' | 'brain_runner'}}
 */
export function describeRuntimeAttentionConfig(env = process.env) {
  const configured = env.HIVEMIND_RUNTIME_ATTENTION_URL;
  if (!configured) return { ok: false, reason: 'not_configured' };
  if (!env.HIVE_HARNESS_RUNNER_SERVICE_SECRET || Buffer.byteLength(env.HIVE_HARNESS_RUNNER_SERVICE_SECRET, 'utf8') < 32) return { ok: false, reason: 'secret_too_short' };
  let url;
  try { url = new URL(configured); } catch { return { ok: false, reason: 'invalid_url' }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return { ok: false, reason: 'invalid_url' };
  if (url.pathname !== '/internal/hivemind/runtime-attention') return { ok: false, reason: 'wrong_path' };
  return BRAIN_RUNNER_HOST.test(configured) ? { ok: false, reason: 'brain_runner' } : { ok: true };
}
export function createRuntimeAttentionBridge({ env = process.env, fetchImpl = fetch } = {}) {
  const secret = env.HIVE_HARNESS_RUNNER_SERVICE_SECRET;
  const configured = env.HIVEMIND_RUNTIME_ATTENTION_URL;
  if (!warnedBrainRunner && BRAIN_RUNNER_HOST.test(String(configured ?? ''))) {
    warnedBrainRunner = true;
    // Brain's chat runner has no attention route: every assessment answers 405 and the event stays pending. Say so in the logs once.
    console.warn('[runtime-attention] HIVEMIND_RUNTIME_ATTENTION_URL points at the Brain chat runner, which does not serve /internal/hivemind/runtime-attention; use the Runtime runner (http://runtime-runner:3080/internal/hivemind/runtime-attention).');
  }
  if (!configured || !secret || Buffer.byteLength(secret, 'utf8') < 32) return undefined;
  let url;
  try { url = new URL(configured); } catch { return undefined; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/internal/hivemind/runtime-attention' || url.search || url.hash) return undefined;
  async function call(operation, row) {
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${runtimeAttentionToken(row, operation, secret)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation, eventId: row.id, orgId: row.org_id, userId: row.user_id }) });
    const text = await response.text();
    if (text.length > 32000) throw Error('runtime_attention_response_too_large');
    if (!response.ok) throw Error('runtime_attention_unavailable');
    return JSON.parse(text);
  }
  // One bounded classification owns this adapter; cache only that event's response.
  const contexts = new Map();
  return {
    async readConsent(row) { const result = await call('context', row); contexts.set(row.id, result); return result.consent; },
    async readSnapshot(row) { const result = contexts.get(row.id); contexts.delete(row.id); return result?.snapshot; },
    async assess(row) { return call('assess', row); },
    async deliver(row) { const result = await call('deliver', row); if (result.status !== 'accepted' || result.eventId !== row.id
      || result.targetSessionId !== row.relevance_decision?.runtimeAttention?.targetSessionId) throw Error('runtime_attention_delivery_unconfirmed'); return result; },
  };
}

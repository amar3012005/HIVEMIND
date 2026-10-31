/** Existing receiver calls this narrow native service seam. No connector subscriptions or model work here. */
import { createHmac, randomUUID } from 'node:crypto';
import { productionConnectedToolkits } from './attention-toolkits.js';
/** Verdict actions an `employees` assessment may answer. */
const EMPLOYEE_ACTIONS = new Set(['retain', 'notify', 'wake']);
/**
 * Signed service token for one attention operation on one event.
 * @param {{id:string,org_id:string,user_id:string}} row Event row.
 * @param {'context'|'assess'|'deliver'} operation Operation the token is bound to.
 * @param {string} secret Runner service secret.
 * @param {number} [now] Clock in milliseconds.
 * @param {'runtime'|'employees'} [destination] Who acts on the verdict; `employees` is signed as a claim, `runtime` is the claim's absence.
 * @returns {string} Bearer token.
 */
export function runtimeAttentionToken(row, operation, secret, now = Date.now(), destination = 'runtime') {
  const at = Math.floor(now / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { iss: 'hivemind-control-plane', aud: 'hivemind-runtime-attention', sub: row.user_id,
    org_id: row.org_id, event_id: row.id, operation, iat: at, exp: at + 30, jti: randomUUID(),
    ...(destination === 'employees' ? { destination } : {}) };
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
const TOOL_SLUG = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/u;
const TOOLKIT = /^[a-z0-9_-]{1,60}$/u;
/** Upper-case slug prefix of a toolkit. */
const prefixOf = toolkit => `${toolkit.toUpperCase().replaceAll('-', '_')}_`;
/**
 * Whether a verdict's chosen tools stay inside the company's connected apps. Runtime built the list from the catalogue Core sent, so this
 * only refuses a verdict that names an app outside it: every tool must belong to a sent app or to the event's own app (the toolkit of the
 * always-included read tool, or the only toolkit named when no catalogue was sent), and its slug must start with its toolkit.
 * @param {object} verdict Runtime's verdict.
 * @param {string[]|undefined} sent Connected apps Core sent with the request.
 * @returns {boolean} True when the tools are admissible or the verdict names none.
 */
export function toolsWithinCatalogue(verdict, sent) {
  if (verdict.tools === undefined) return true;
  const tools = verdict.tools;
  if (!Array.isArray(tools) || tools.length > 8 || tools.some(tool => !tool || typeof tool.slug !== 'string' || !TOOL_SLUG.test(tool.slug)
    || typeof tool.toolkit !== 'string' || !TOOLKIT.test(tool.toolkit) || !tool.slug.startsWith(prefixOf(tool.toolkit)))) return false;
  const own = tools.find(tool => tool.ownRead === true)?.toolkit ?? tools[0]?.toolkit;
  const allowed = new Set([...(sent ?? []), ...(own ? [own] : [])]);
  if (!sent?.length) return tools.every(tool => tool.toolkit === own);
  if (!Array.isArray(verdict.toolSlugs)) return false;
  const byToolkit = new Set(tools.map(tool => tool.slug));
  return tools.every(tool => allowed.has(tool.toolkit)) && verdict.toolSlugs.every(slug => byToolkit.has(slug));
}

export function createRuntimeAttentionBridge({ env = process.env, fetchImpl = fetch, connectedToolkits = env === process.env ? productionConnectedToolkits() : undefined } = {}) {
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
  async function post(operation, row, destination, extra) {
    // A Runtime destination sends no destination field, so a runner that predates it keeps answering unchanged.
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${runtimeAttentionToken(row, operation, secret, Date.now(), destination)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation, eventId: row.id, orgId: row.org_id, userId: row.user_id, ...(destination === 'employees' ? { destination } : {}), ...extra }) });
    const text = await response.text();
    if (text.length > 32000) throw Error('runtime_attention_response_too_large');
    return { response, text };
  }
  /**
   * Only an assess carries the company's connected apps. A runner that predates the field refuses it with 400; the call is then repeated
   * without it, so release order between Runtime and Core does not matter and the runner assesses with the event's own app only.
   */
  async function call(operation, row, destination = 'runtime') {
    let sent = operation === 'assess' && connectedToolkits ? await connectedToolkits(row) : undefined;
    if (!sent?.length) sent = undefined;
    let { response, text } = await post(operation, row, destination, sent ? { connectedToolkits: sent } : {});
    if (response.status === 400 && sent) { sent = undefined; ({ response, text } = await post(operation, row, destination, {})); }
    if (!response.ok) throw Error('runtime_attention_unavailable');
    const result = JSON.parse(text);
    if (operation !== 'assess' || result === null || typeof result !== 'object') return result;
    if (toolsWithinCatalogue(result, sent)) return result;
    // A verdict that names an app outside the company's catalogue keeps its attention answer but loses its tool choice (Runtime then uses the fixed list).
    const { toolSlugs: _slugs, tools: _tools, toolSelection: _selection, ...rest } = result;
    return destination === 'employees' ? { ...rest, toolSlugs: [] } : rest;
  }
  // One bounded classification owns this adapter; cache only that event's response.
  const contexts = new Map();
  return {
    async readConsent(row) { const result = await call('context', row); contexts.set(row.id, result); return result.consent; },
    async readSnapshot(row) { const result = contexts.get(row.id); contexts.delete(row.id); return result?.snapshot; },
    async assess(row) { return call('assess', row); },
    /**
     * Runtime's attention verdict for the company's AI employees (Runtime switched off). Never delivers or wakes Runtime.
     * @param {object} row Event row.
     * @returns {Promise<object>} The verdict: destination `employees`, action retain|notify|wake, assessment answers and `toolSlugs`.
     * @throws {Error} `runtime_attention_unavailable` or `runtime_attention_invalid_employee_verdict`; the caller falls back.
     */
    async assessForEmployees(row) {
      const verdict = await call('assess', row, 'employees');
      if (!verdict || verdict.destination !== 'employees' || !EMPLOYEE_ACTIONS.has(verdict.action) || verdict.targetSessionId !== undefined
        || (verdict.toolSlugs !== undefined && (!Array.isArray(verdict.toolSlugs) || verdict.toolSlugs.length > 8
          || verdict.toolSlugs.some(slug => typeof slug !== 'string' || !/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/u.test(slug))))) throw Error('runtime_attention_invalid_employee_verdict');
      return verdict;
    },
    async deliver(row) { const result = await call('deliver', row); if (result.status !== 'accepted' || result.eventId !== row.id
      || result.targetSessionId !== row.relevance_decision?.runtimeAttention?.targetSessionId) throw Error('runtime_attention_delivery_unconfirmed'); return result; },
  };
}

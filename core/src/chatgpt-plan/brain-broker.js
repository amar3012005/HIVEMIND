import { registeredRefresh } from './oauth.js';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { ChatgptPlanError, resolveBrainPlan } from './connections.js';
import { gatewayRequestHeaders, cloudflareGatewayConfig } from '../llm/cloudflare-gateway.js';

const ALLOWED = new Set(['model', 'input', 'instructions', 'tools', 'store', 'stream']);
export function validatePlanRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !ALLOWED.has(key)) || body.store !== false || body.stream !== true
    || typeof body.model !== 'string' || !Array.isArray(body.input) || !body.input.length
    || body.input.length > 1000 || JSON.stringify(body).length > 2_000_000) {
    throw new ChatgptPlanError('plan_request_contract_invalid', 400);
  }
  if (body.input.some(item => !item || typeof item !== 'object' || Array.isArray(item)
    || item.role === 'system' || !['user', 'assistant', undefined].includes(item.role)
    || (item.type && !['function_call', 'function_call_output', 'message'].includes(item.type)))) {
    throw new ChatgptPlanError('plan_input_contract_invalid', 400);
  }
  if (body.instructions !== undefined && typeof body.instructions !== 'string') throw new ChatgptPlanError('plan_instructions_invalid', 400);
  if (body.tools && (!Array.isArray(body.tools) || body.tools.some(group => !group || group.type !== 'namespace' || group.name !== 'hivemind'
    || !Array.isArray(group.tools) || group.tools.some(tool => !tool || tool.type !== 'function' || typeof tool.name !== 'string' || !tool.name)))) {
    throw new ChatgptPlanError('plan_function_namespace_required', 400);
  }
  return body;
}
/** Grant never leaves Core. Runner receives only the provider SSE stream. */
export async function serveBrainPlan({ req, res, prisma, claims, parseBody, env, fetchImpl = fetch, jsonResponse }) {
  if (req.method !== 'POST') { jsonResponse(res, { error: 'Method not allowed' }, 405); return; }
  const abort = new AbortController();
  const closed = () => { if (!res.writableEnded) abort.abort(); };
  res.on('close', closed);
  try {
    const input = await parseBody(req);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['session_id', 'request'].includes(key))) throw new ChatgptPlanError('plan_billing_owner_is_server_owned', 400);
    const body = validatePlanRequest(input.request);
    const { accessToken } = await resolveBrainPlan(prisma, { orgId: claims.org_id, userId: claims.sub }, input.session_id, body.model, env, { refresh: registeredRefresh(env, fetchImpl) });
    const gateway = cloudflareGatewayConfig();
    if (!gateway.enabled) throw new ChatgptPlanError('user_plan_gateway_required', 503);
    const url = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(gateway.accountId)}/${encodeURIComponent(gateway.gatewayId)}/openai/responses`;
    const headers = gatewayRequestHeaders({ authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
      'user-agent': /^deepseek-harness\/[\w.+-]+ \(\+https:\/\/github\.com\/deepseek-ai\/deepseek-harness\)$/.test(req.headers?.['user-agent'] || '') ? req.headers['user-agent'] : 'hivemind-chatgpt-plan/1' }, 'openai', { billingMode: 'user-plan' });
    const upstream = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]) });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      throw new ChatgptPlanError(`plan_upstream_${upstream.status}`, upstream.status === 429 ? 429 : 502);
    }
    if (!upstream.headers.get('content-type')?.includes('text/event-stream')) {
      await upstream.body.cancel(); throw new ChatgptPlanError('plan_stream_required', 502);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-hivemind-billing': 'user-plan' });
    await pipeline(Readable.fromWeb(upstream.body), res, { signal: abort.signal });
  } catch (error) {
    if (!res.headersSent) jsonResponse(res, { error: error instanceof ChatgptPlanError ? error.code : 'plan_request_failed' },
      error instanceof ChatgptPlanError ? error.status : 503);
    else res.destroy();
  } finally { res.off('close', closed); }
}

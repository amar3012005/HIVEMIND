/**
 * hm-control → Hermes gateway client (Phase 4).
 *
 * The ONLY path from HIVEMIND into a Hermes runtime. hm-control (and only
 * hm-control — never the FE directly) calls runOnce() to dispatch a job to the
 * tenant's Hermes profile via the gateway's OpenAI-compatible API on :8642.
 * HiveMind MCP (wired into the profile, Phase 3) remains the memory SoR.
 *
 * Transport: POST {gateway}/v1/chat/completions  (model "hermes-agent"),
 * Bearer API_SERVER_KEY. The gateway runs the agent synchronously and returns
 * the completion; usage + content are surfaced as the job result.
 *
 * @module hermes/hm-control-client
 */
import { validateHermesAgentConfig } from './agent-config.js';

const DEFAULT_GATEWAY = process.env.HERMES_GATEWAY_URL || 'http://hm-hermes:8642';
const DEFAULT_MODEL = process.env.HERMES_GATEWAY_MODEL || 'hermes-agent';

/** @returns {string} the gateway API key (env only — never a literal). */
function gatewayKey() {
  return process.env.HERMES_API_SERVER_KEY || '';
}

async function withTimeout(promiseFn, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promiseFn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Reachability + auth probe against the gateway.
 * @param {{ baseUrl?: string, apiKey?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ reachable: boolean, authed: boolean, models: string[], error: string|null }>}
 */
export async function checkHealth({ baseUrl = DEFAULT_GATEWAY, apiKey = gatewayKey(), timeoutMs = 8000 } = {}) {
  try {
    const res = await withTimeout(
      (signal) => fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal }),
      timeoutMs,
    );
    if (res.status === 200) {
      const j = await res.json().catch(() => ({}));
      return { reachable: true, authed: true, models: (j.data || []).map((m) => m.id), error: null };
    }
    return { reachable: true, authed: false, models: [], error: `HTTP ${res.status}` };
  } catch (err) {
    return { reachable: false, authed: false, models: [], error: err.message };
  }
}

/**
 * Dispatch ONE job to a tenant's Hermes runtime. Validates the agent config
 * (Phase 1 contract) before dispatch.
 *
 * @param {object} agentConfig  a HermesAgentConfig (see agent-config.schema.json)
 * @param {{ task: string, context?: string }} payload  the work for the agent
 * @param {{ baseUrl?: string, apiKey?: string }} [opts]
 * @returns {Promise<{ ok: boolean, job_id: string|null, status: 'completed'|'failed', result: string|null, usage: object|null, issues: string[] }>}
 */
export async function runOnce(agentConfig, payload, { baseUrl = DEFAULT_GATEWAY, apiKey = gatewayKey() } = {}) {
  const { valid, errors } = validateHermesAgentConfig(agentConfig);
  if (!valid) {
    return { ok: false, job_id: null, status: 'failed', result: null, usage: null, issues: ['invalid_agent_config', ...errors] };
  }
  if (!payload?.task || typeof payload.task !== 'string') {
    return { ok: false, job_id: null, status: 'failed', result: null, usage: null, issues: ['payload.task (string) required'] };
  }
  if (agentConfig.status !== 'active') {
    return { ok: false, job_id: null, status: 'failed', result: null, usage: null, issues: [`agent status is '${agentConfig.status}', not active`] };
  }

  const timeoutMs = Math.min(Number(agentConfig.safety_policy?.max_runtime_seconds || 600), 86400) * 1000;
  const maxTokens = Math.min(Number(agentConfig.safety_policy?.max_tokens_per_run || 100000), 5000000);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const sys = `You are the "${agentConfig.name}" agent for tenant ${agentConfig.tenant_id}. `
    + `Today's date is ${today} (UTC). `
    + 'Use the hivemind MCP tools (recall / search / list / save) for all memory operations — they are the system of record. '
    + 'For time-relative requests (e.g. "last 7 days"), work out the date range yourself from today\'s date — do NOT run code or Python just to compute dates. '
    + 'Prefer the available MCP, web, and browser tools over code execution. Do NOT ask the user to approve running code; if a step would need approval you cannot get, accomplish the task another way with the tools you already have, and answer directly. '
    + (payload.context ? `Context: ${payload.context}` : '');

  try {
    const res = await withTimeout((signal) => fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: payload.task }],
        max_tokens: maxTokens,
        stream: false,
      }),
      signal,
    }), timeoutMs);

    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 2000) }; }
    if (!res.ok) {
      return { ok: false, job_id: body?.id || null, status: 'failed', result: null, usage: null, issues: [`gateway HTTP ${res.status}`, body?.error?.message || text.slice(0, 300)] };
    }
    const result = body?.choices?.[0]?.message?.content ?? null;
    return { ok: true, job_id: body?.id || null, status: 'completed', result, usage: body?.usage || null, issues: [] };
  } catch (err) {
    return { ok: false, job_id: null, status: 'failed', result: null, usage: null, issues: [`dispatch_error: ${err.message}`] };
  }
}

/**
 * Job status. The gateway chat API is synchronous, so runOnce already returns
 * the terminal result; this returns gateway reachability as a liveness signal.
 * Async/long-running job tracking is a future extension (gateway job API).
 * @param {{ baseUrl?: string, apiKey?: string }} [opts]
 * @returns {Promise<{ gateway: object }>}
 */
export async function getStatus(opts = {}) {
  return { gateway: await checkHealth(opts) };
}

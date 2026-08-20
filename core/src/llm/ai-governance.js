import crypto from 'node:crypto';
import { currentApiKey, currentOrg, currentUser } from '../db/prisma.js';

export const MODEL_POLICY_DEFAULTS = Object.freeze({
  chat_planner: ['google/gemini-2.5-flash-lite', 'openai/gpt-oss-20b:nitro'],
  chat_synthesis: ['openai/gpt-oss-20b:nitro', 'nvidia/nemotron-3.5-lightning:nitro'],
  compound_subtask: ['openai/gpt-oss-20b:nitro', 'google/gemini-2.5-flash-lite'],
  ingestion_extraction: ['singulance/qwen3-ingest', 'google/gemini-2.5-flash-lite'],
  entity_linking: ['singulance/qwen3-ingest', 'google/gemini-2.5-flash-lite'],
  meeting_insights: ['openai/gpt-oss-20b:nitro', 'deepseek/deepseek-v4-flash-0731'],
  hq_dispatch: ['deepseek/deepseek-v4-flash-0731', 'openai/gpt-oss-20b:nitro'],
  general: ['openai/gpt-oss-20b:nitro', 'nvidia/nemotron-3.5-lightning:nitro'],
});

let prisma = null;
let policyCache = { expires: 0, rows: new Map() };
const TTL_MS = 15_000;
const MODEL_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/;

export function configureAiGovernance(client) { prisma = client || null; }
export function invalidateAiModelPolicyCache() { policyCache = { expires: 0, rows: new Map() }; }
export function validateModelId(value) {
  const model = String(value || '').trim();
  if (!MODEL_RE.test(model) || model.length > 160) throw new Error('Invalid model identifier');
  return model;
}

// The platform-admin UI and the public control-plane API have historically
// used different JavaScript naming conventions. Normalize at the authority
// boundary so a successful Save can never silently leave the policy unchanged.
export function normalizeModelPolicyInput(input = {}) {
  const raw = input && typeof input === 'object' && input.policy && typeof input.policy === 'object'
    ? input.policy
    : (input || {});
  return {
    useCase: raw.use_case ?? raw.useCase,
    primaryModel: raw.primary_model ?? raw.primaryModel,
    secondaryModel: raw.secondary_model ?? raw.secondaryModel ?? null,
  };
}

async function policyRows() {
  if (!prisma) return new Map();
  if (policyCache.expires > Date.now()) return policyCache.rows;
  try {
    const rows = await prisma.$queryRawUnsafe('SELECT use_case, primary_model, secondary_model, enabled, revision, updated_by, updated_at FROM hivemind.ai_model_policies');
    policyCache = { expires: Date.now() + TTL_MS, rows: new Map(rows.map((row) => [row.use_case, row])) };
  } catch { policyCache = { expires: Date.now() + 2_000, rows: new Map() }; }
  return policyCache.rows;
}

export async function resolveAiModelPolicy(useCase = 'general', requestedModel = null) {
  const key = MODEL_POLICY_DEFAULTS[useCase] ? useCase : 'general';
  const row = (await policyRows()).get(key);
  const defaults = MODEL_POLICY_DEFAULTS[key];
  if (row?.enabled) return { useCase: key, primary: row.primary_model, secondary: row.secondary_model || null, source: 'admin', revision: row.revision };
  return { useCase: key, primary: requestedModel || defaults[0], secondary: defaults[1] || null, source: requestedModel ? 'caller' : 'default', revision: 0 };
}

function usageNumbers(usage = {}) {
  const prompt = Math.max(0, Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0);
  const completion = Math.max(0, Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0);
  const cached = Math.max(0, Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0) || 0);
  const reasoning = Math.max(0, Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0) || 0);
  return { prompt, completion, cached, reasoning };
}

export async function recordAiUsage({ usage, requestedModel, servedModel, provider, useCase = 'general', status = 'completed', gatewayRequestId = null, traceId = null, idempotencyKey = null, requestCount = 1 }) {
  if (!prisma) return;
  const n = usageNumbers(usage);
  if (!(n.prompt + n.completion + n.cached + n.reasoning > 0)) return;
  const model = String(servedModel || requestedModel || 'unknown').slice(0, 160);
  const host = String(provider || 'unknown').slice(0, 80);
  try {
    const priceRows = await prisma.$queryRawUnsafe(
      `SELECT input_micros_per_million, output_micros_per_million, cache_read_micros_per_million
       FROM hivemind.ai_model_prices WHERE model = $1 AND provider IN ($2, '*')
       AND effective_from <= NOW() AND (effective_to IS NULL OR effective_to > NOW())
       ORDER BY CASE WHEN provider = $2 THEN 0 ELSE 1 END, effective_from DESC LIMIT 1`, model, host,
    );
    const price = priceRows[0] || {};
    const inputRate = BigInt(price.input_micros_per_million || 0);
    const outputRate = BigInt(price.output_micros_per_million || 0);
    const cacheRate = BigInt(price.cache_read_micros_per_million || 0);
    const inputCost = BigInt(Math.max(0, n.prompt - n.cached)) * inputRate / 1_000_000n;
    const outputCost = BigInt(n.completion) * outputRate / 1_000_000n;
    const cacheCost = BigInt(n.cached) * cacheRate / 1_000_000n;
    const reportedUsd = Number(usage?.cost ?? usage?.cost_details?.upstream_inference_cost);
    const reportedCost = Number.isFinite(reportedUsd) && reportedUsd >= 0 ? BigInt(Math.round(reportedUsd * 1_000_000)) : null;
    const total = reportedCost ?? (inputCost + outputCost + cacheCost);
    await prisma.$executeRawUnsafe(
      `INSERT INTO hivemind.ai_usage_events
       (idempotency_key, org_id, user_id, api_key_id, trace_id, use_case, requested_model, served_model, provider, request_count,
        prompt_tokens, completion_tokens, cached_prompt_tokens, reasoning_tokens, input_cost_micros, output_cost_micros,
        cache_cost_micros, provider_reported_cost_micros, total_cost_micros, pricing_source, applied_pricing, status, gateway_request_id)
       VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22,$23)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      String(idempotencyKey || crypto.randomUUID()).slice(0, 180), currentOrg(), currentUser(), currentApiKey(), traceId,
      String(useCase).slice(0, 80), String(requestedModel || model).slice(0, 160), model, host, Math.max(1, Number(requestCount) || 1),
      n.prompt, n.completion, n.cached, n.reasoning, inputCost, outputCost, cacheCost, reportedCost, total,
      reportedCost != null ? 'provider_reported' : (priceRows[0] ? 'catalog' : 'unpriced'), JSON.stringify({ input_micros_per_million: inputRate.toString(), output_micros_per_million: outputRate.toString(), cache_read_micros_per_million: cacheRate.toString() }),
      String(status).slice(0, 24), gatewayRequestId,
    );
  } catch (error) { console.warn('[ai-governance] usage recording failed:', error.message); }
}

export async function listModelGovernance() {
  const rows = await policyRows();
  return Object.entries(MODEL_POLICY_DEFAULTS).map(([use_case, defaults]) => {
    const row = rows.get(use_case);
    return { use_case, primary_model: row?.primary_model || defaults[0], secondary_model: row?.secondary_model || defaults[1] || null,
      source: row?.enabled ? 'admin' : 'default', revision: row?.revision || 0, updated_by: row?.updated_by || null, updated_at: row?.updated_at || null };
  });
}

export async function upsertModelPolicy({ useCase, primaryModel, secondaryModel, operator }) {
  const key = String(useCase || '').trim();
  if (!MODEL_POLICY_DEFAULTS[key]) throw new Error('Unknown model use case');
  const primary = validateModelId(primaryModel);
  const secondary = secondaryModel ? validateModelId(secondaryModel) : null;
  if (secondary === primary) throw new Error('Primary and secondary models must differ');
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO hivemind.ai_model_policies(use_case, primary_model, secondary_model, updated_by)
     VALUES ($1,$2,$3,$4) ON CONFLICT(use_case) DO UPDATE SET primary_model=EXCLUDED.primary_model,
     secondary_model=EXCLUDED.secondary_model, enabled=true, revision=hivemind.ai_model_policies.revision+1,
     updated_by=EXCLUDED.updated_by, updated_at=NOW() RETURNING *`, key, primary, secondary, String(operator || '').slice(0, 120),
  );
  invalidateAiModelPolicyCache();
  return rows[0];
}

export async function listModelPrices() {
  return prisma.$queryRawUnsafe(`SELECT id, model, provider, currency, input_micros_per_million::text, output_micros_per_million::text,
    cache_read_micros_per_million::text, effective_from, updated_by FROM hivemind.ai_model_prices WHERE effective_to IS NULL ORDER BY model, provider`);
}

export async function replaceModelPrice({ model, provider = '*', inputMicros, outputMicros, cacheMicros = 0, operator }) {
  const m = validateModelId(model); const p = String(provider || '*').trim().slice(0, 80) || '*';
  const values = [inputMicros, outputMicros, cacheMicros].map((v) => BigInt(v || 0));
  if (values.some((v) => v < 0n)) throw new Error('Prices cannot be negative');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('UPDATE hivemind.ai_model_prices SET effective_to=NOW() WHERE model=$1 AND provider=$2 AND effective_to IS NULL', m, p);
    const rows = await tx.$queryRawUnsafe(`INSERT INTO hivemind.ai_model_prices(model,provider,input_micros_per_million,output_micros_per_million,cache_read_micros_per_million,updated_by)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, m, p, values[0], values[1], values[2], String(operator || '').slice(0,120));
    const row = rows[0];
    return { ...row, input_micros_per_million: String(row.input_micros_per_million), output_micros_per_million: String(row.output_micros_per_million), cache_read_micros_per_million: String(row.cache_read_micros_per_million) };
  });
}

export async function userCostSummary({ limit = 200, query = '' } = {}) {
  return prisma.$queryRawUnsafe(
    `SELECT u.id, u.email, u.display_name, COALESCE(SUM(e.request_count),0)::text AS calls,
      COALESCE(SUM(e.prompt_tokens),0)::text AS prompt_tokens, COALESCE(SUM(e.completion_tokens),0)::text AS completion_tokens,
      COALESCE(SUM(e.cached_prompt_tokens),0)::text AS cached_prompt_tokens, COALESCE(SUM(e.total_cost_micros),0)::text AS total_cost_micros,
      MAX(e.occurred_at) AS last_call_at
     FROM users u LEFT JOIN hivemind.ai_usage_events e ON e.user_id=u.id
     WHERE u.deleted_at IS NULL AND ($1='' OR u.email ILIKE '%'||$1||'%' OR COALESCE(u.display_name,'') ILIKE '%'||$1||'%')
     GROUP BY u.id,u.email,u.display_name ORDER BY COALESCE(SUM(e.total_cost_micros),0) DESC LIMIT $2`, String(query).slice(0,120), Math.min(500, Math.max(1, Number(limit)||200)),
  );
}

export async function totalAiCost() {
  const rows = await prisma.$queryRawUnsafe(`SELECT COALESCE(SUM(total_cost_micros),0)::text AS total_cost_micros,
    COALESCE(SUM(total_cost_micros) FILTER (WHERE user_id IS NULL),0)::text AS unattributed_cost_micros,
    COALESCE(SUM(request_count) FILTER (WHERE user_id IS NULL),0)::text AS unattributed_calls FROM hivemind.ai_usage_events`);
  return rows[0] || { total_cost_micros: '0', unattributed_cost_micros: '0', unattributed_calls: '0' };
}

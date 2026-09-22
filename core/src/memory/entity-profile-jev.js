import { gatewayCompatUrl, gatewayRequestHeaders } from '../llm/cloudflare-gateway.js';

const CLASSES = new Set(['static', 'dynamic', 'relationship', 'historical']);
const ACTIONS = new Set(['auto_apply', 'review', 'reject']);
const TIERS = new Set(['low', 'medium', 'high']);

export function validateEntityProfileDecision(value) {
  if (!value || typeof value !== 'object') return null;
  const factClass = String(value.fact_class || 'historical');
  const action = String(value.action || 'review');
  const confidenceTier = String(value.confidence_tier || 'low');
  if (!CLASSES.has(factClass) || !ACTIONS.has(action) || !TIERS.has(confidenceTier)) return null;
  return {
    durable: value.durable === true,
    fact_class: factClass,
    duplicate: value.duplicate === true,
    confidence_tier: confidenceTier,
    contradiction: value.contradiction === true,
    action,
  };
}

// JEV is advisory only. The caller must still verify authorization, evidence,
// duplicate keys, confidence, and the fact-class rollout policy before writing.
export async function decideEntityProfileCandidate({ candidate, fetchImpl = fetch, env = process.env }) {
  if (String(env.ENTITY_PROFILE_JEV_ENABLED || '').toLowerCase() !== 'true') return null;
  const endpoint = gatewayCompatUrl('/chat/completions');
  const model = String(env.ENTITY_PROFILE_JEV_MODEL || '').trim();
  if (!endpoint || !model) return null;
  const bounded = {
    predicate: String(candidate?.predicate || '').slice(0, 80),
    subject_kind: String(candidate?.subject_kind || '').slice(0, 40),
    object_kind: String(candidate?.object_kind || '').slice(0, 40),
    object_literal: candidate?.object_literal ?? null,
    evidence_count: Math.min(Number(candidate?.evidence_count || 0), 20),
    direct_evidence: candidate?.direct_evidence === true,
    confidence: Math.max(0, Math.min(1, Number(candidate?.confidence || 0))),
  };
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: gatewayRequestHeaders({ 'content-type': 'application/json' }, 'openrouter'),
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 160,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Classify one evidence-backed entity profile candidate. Return JSON only: durable:boolean, fact_class:static|dynamic|relationship|historical, duplicate:boolean, confidence_tier:low|medium|high, contradiction:boolean, action:auto_apply|review|reject. Never infer facts.' },
        { role: 'user', content: JSON.stringify(bounded) },
      ],
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  const content = body?.choices?.[0]?.message?.content;
  try { return validateEntityProfileDecision(JSON.parse(content)); } catch { return null; }
}

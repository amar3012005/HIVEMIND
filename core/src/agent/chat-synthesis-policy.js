export function shouldOptimizeRecallQuery({ canonicalQuery, useTools = false } = {}) {
  // Native chat planning already returns an intent-preserving canonical
  // retrieval query in the same structured call. Rewriting it again before
  // recall paid for a second LLM call (~1.2-1.7s) and could erase exact names.
  // Keep the optimizer only as a compatibility path for missing planner output
  // or tool-enabled turns; zero-coverage recovery remains independently bounded.
  // use_tools:false has exactly one semantic LLM call. On planner failure the
  // original user message is the safe retrieval query; starting a second model
  // would violate that latency and authority contract.
  return useTools === true;
}

export function shouldRunRecallOptimizer({ operation } = {}) {
  return !new Set(['aggregate', 'connector_read', 'relation_between', 'profile']).has(operation);
}

export function shouldRetryAfterZeroCoverage({ router, canonicalQuery, coverage, alreadyOptimized = false, useTools = false } = {}) {
  if (useTools !== true) return false;
  return router === 'progressive'
    && !!String(canonicalQuery || '').trim()
    && coverage?.evidence_found === false
    && alreadyOptimized !== true;
}

export function isCandidateSynthesisAcceptable(answer) {
  return answer?.grounded === true
    && typeof answer?.response === 'string'
    && answer.response.trim().length > 0
    && Array.isArray(answer?.claims)
    && answer.claims.length > 0
    && answer.claims.every((claim) => claim?.grounded === true
      && Array.isArray(claim?.citation_ids)
      && claim.citation_ids.length > 0);
}

export function isFailClosedSynthesisResponse(answer) {
  return answer?.grounded === false
    && Array.isArray(answer?.claims)
    && answer.claims.length === 0
    && typeof answer?.response === 'string'
    && answer.response.trim().length > 0
    && Array.isArray(answer?.gaps)
    && answer.gaps.length > 0;
}

export function hasGroundingEvidence(evidence = {}) {
  return ['memories', 'evidence', 'live', 'graph_edges', 'synthesis_chains']
    .some((key) => Array.isArray(evidence?.[key]) && evidence[key].length > 0)
    || (Array.isArray(evidence?.recall_packets)
      && evidence.recall_packets.some((packet) => (
        (Array.isArray(packet?.facts) && packet.facts.length > 0)
        || (Array.isArray(packet?.sourceSections) && packet.sourceSections.length > 0)
        || (Array.isArray(packet?.citations) && packet.citations.length > 0)
      )));
}

export function buildSynthesisFallbackChain({ served, requested, finalFallback } = {}) {
  return [...new Set([served, requested, finalFallback]
    .map((model) => String(model || '').trim())
    .filter(Boolean))];
}

/**
 * JSON-mode providers may legally return the JSON literal `null`, an array,
 * or another scalar even when the caller requested an object. Normalize that
 * boundary once so downstream synthesis never dereferences a non-object.
 */
export function normalizeJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function parseJsonObjectContent(raw = '{}') {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || '{}'));
  } catch {
    const match = String(raw || '').match(/\{[\s\S]+\}/);
    if (!match) return {};
    try { parsed = JSON.parse(match[0]); } catch { return {}; }
  }
  return normalizeJsonObject(parsed);
}

export function scheduleShadowEvaluation({ execute, timeoutMs = 5000, onResult = () => {} } = {}) {
  if (typeof execute !== 'function') return;
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(new Error('shadow_timeout')), timeoutMs);
  void Promise.resolve()
    .then(() => execute(controller.signal))
    .then((answer) => onResult({ ok: true, answer, ms: Date.now() - startedAt }))
    .catch((error) => onResult({ ok: false, error, ms: Date.now() - startedAt }))
    .finally(() => clearTimeout(timer));
}

export function chooseSynthesisModel({
  currentModel,
  operation,
  recallMode,
  useTools = false,
} = {}) {
  const candidate = String(
    process.env.HIVEMIND_FACT_SYNTHESIS_MODEL || 'nvidia/nemotron-3.5-lightning:nitro',
  ).trim();
  // Nemotron remains an explicit experiment. Production fact synthesis uses
  // the caller's Nitro model unless this canary is deliberately enabled.
  const enabled = process.env.HIVEMIND_NEMOTRON_SYNTHESIS_ENABLED === 'true';
  const eligible = enabled
    && useTools !== true
    && operation === 'recall'
    && !['timeline', 'aggregate', 'relation_between', 'source_read', 'profile', 'connector_read'].includes(recallMode);
  return {
    served: eligible ? candidate : currentModel,
    shadow: null,
    eligible,
    fallback: currentModel,
    reasoning: eligible ? 'disabled' : 'provider_default',
  };
}

export function summarizeUsage(stages = {}) {
  const all = Object.values(stages).filter(Boolean);
  const prompt_tokens = all.reduce((sum, usage) => sum + (Number(usage.prompt_tokens) || 0), 0);
  const completion_tokens = all.reduce((sum, usage) => sum + (Number(usage.completion_tokens) || 0), 0);
  const cached_prompt_tokens = all.reduce((sum, usage) => sum + (Number(usage.prompt_tokens_details?.cached_tokens) || 0), 0);
  const cache_write_prompt_tokens = all.reduce((sum, usage) => sum + (Number(usage.prompt_tokens_details?.cache_write_tokens) || 0), 0);
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: all.reduce((sum, usage) => sum + (Number(usage.total_tokens) || ((Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0))), 0),
    cached_prompt_tokens,
    uncached_prompt_tokens: Math.max(0, prompt_tokens - cached_prompt_tokens),
    cache_write_prompt_tokens,
    cache_hit_ratio: prompt_tokens > 0 ? Number((cached_prompt_tokens / prompt_tokens).toFixed(4)) : 0,
  };
}

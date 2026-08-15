export function shouldOptimizeRecallQuery({ router, canonicalQuery } = {}) {
  // Every retrieval-bearing chat turn gets one compact semantic rewrite.
  // Router output remains a useful seed, but it is not assumed to be the best
  // retrieval representation across languages, shorthand, or follow-ups.
  // The caller invokes this only on recall lanes, so greetings/direct answers
  // still pay no optimizer cost.
  return true;
}

export function shouldRunRecallOptimizer({ operation } = {}) {
  return !new Set(['aggregate', 'connector_read', 'relation_between', 'profile']).has(operation);
}

export function shouldRetryAfterZeroCoverage({ router, canonicalQuery, coverage, alreadyOptimized = false } = {}) {
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
  const enabled = process.env.HIVEMIND_NEMOTRON_SYNTHESIS_ENABLED !== 'false';
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

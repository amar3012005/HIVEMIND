export function shouldOptimizeRecallQuery({ router, canonicalQuery } = {}) {
  return router !== 'progressive' || !String(canonicalQuery || '').trim();
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
} = {}) {
  // Final synthesis is server-owned. Historical DeepSeek shadow/canary flags
  // must not silently replace the configured final-answer model or duplicate
  // a user turn after this policy was promoted to GPT-OSS-20B Nitro.
  return {
    served: currentModel,
    shadow: null,
    eligible: false,
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

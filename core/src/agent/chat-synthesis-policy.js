export const DEEPSEEK_SYNTHESIS_MODEL = 'deepseek/deepseek-v4-flash-0731';

export function shouldOptimizeRecallQuery({ router, canonicalQuery } = {}) {
  return router !== 'progressive' || !String(canonicalQuery || '').trim();
}

export function chooseSynthesisModel({
  operation,
  recallMode,
  useTools = false,
  currentModel,
  shadowEnabled = false,
  canaryEnabled = false,
} = {}) {
  const eligibleFactRecall = operation === 'recall' && recallMode === 'fact' && useTools !== true;
  const eligible = eligibleFactRecall && (shadowEnabled || canaryEnabled);
  return {
    served: eligibleFactRecall && canaryEnabled ? DEEPSEEK_SYNTHESIS_MODEL : currentModel,
    // A canary already serves the candidate; never pay for a second identical
    // shadow call on that same turn.
    shadow: eligibleFactRecall && shadowEnabled && !canaryEnabled ? DEEPSEEK_SYNTHESIS_MODEL : null,
    eligible,
  };
}

export function summarizeUsage(stages = {}) {
  const all = Object.values(stages).filter(Boolean);
  const prompt_tokens = all.reduce((sum, usage) => sum + (Number(usage.prompt_tokens) || 0), 0);
  const completion_tokens = all.reduce((sum, usage) => sum + (Number(usage.completion_tokens) || 0), 0);
  const cached_prompt_tokens = all.reduce((sum, usage) => sum + (Number(usage.prompt_tokens_details?.cached_tokens) || 0), 0);
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: all.reduce((sum, usage) => sum + (Number(usage.total_tokens) || ((Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0))), 0),
    cached_prompt_tokens,
    uncached_prompt_tokens: Math.max(0, prompt_tokens - cached_prompt_tokens),
  };
}

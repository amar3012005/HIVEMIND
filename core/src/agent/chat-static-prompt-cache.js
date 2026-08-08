import { createHash } from 'node:crypto';

const MAX_ENTRIES = 64;
const entries = new Map();

function fingerprint(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function estimateTokens(value) {
  // Provider tokenization is authoritative. This estimate exists only to split
  // static and dynamic prompt contribution before provider usage is returned.
  return Math.max(0, Math.ceil(String(value || '').length / 4));
}

export function getStaticPromptArtifact({ family, version, variant = 'default', build } = {}) {
  if (typeof build !== 'function') throw new Error('static_prompt_builder_required');
  const key = `${String(family || 'prompt')}:${String(version || 'v1')}:${String(variant || 'default')}`;
  const cached = entries.get(key);
  if (cached) {
    return { ...cached, cache: 'hit' };
  }

  const value = String(build());
  const artifact = {
    key,
    value,
    fingerprint: fingerprint(value),
    chars: value.length,
    estimated_tokens: estimateTokens(value),
  };
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
  entries.set(key, artifact);
  return { ...artifact, cache: 'miss' };
}

export function promptContributionTelemetry({ staticPrompt = '', dynamicPrompt = '' } = {}) {
  return {
    static_chars: String(staticPrompt).length,
    dynamic_chars: String(dynamicPrompt).length,
    static_estimated_tokens: estimateTokens(staticPrompt),
    dynamic_estimated_tokens: estimateTokens(dynamicPrompt),
  };
}

export function resetStaticPromptCacheForTests() {
  entries.clear();
}

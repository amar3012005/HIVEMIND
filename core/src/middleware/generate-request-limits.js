/**
 * Request bounds for POST /api/generate, a direct pass-through to the shared
 * platform LLM key. Without them one API key can spend the provider quota
 * that other tenants' chat depends on.
 *
 * Deployment tunables (validated at load):
 *   HIVEMIND_GENERATE_MAX_PROMPT_CHARS  (default 32768)
 *   HIVEMIND_GENERATE_MAX_TOKENS        (default 4096)
 *   HIVEMIND_GENERATE_RPM_PER_ORG       (default 30)
 */

function positiveInteger(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * Resolve the configured bounds.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ maxPromptChars: number, maxTokens: number, rpmPerOrg: number }}
 */
export function resolveGenerateLimits(env = process.env) {
  return {
    maxPromptChars: positiveInteger('HIVEMIND_GENERATE_MAX_PROMPT_CHARS', env.HIVEMIND_GENERATE_MAX_PROMPT_CHARS, 32768),
    maxTokens: positiveInteger('HIVEMIND_GENERATE_MAX_TOKENS', env.HIVEMIND_GENERATE_MAX_TOKENS, 4096),
    rpmPerOrg: positiveInteger('HIVEMIND_GENERATE_RPM_PER_ORG', env.HIVEMIND_GENERATE_RPM_PER_ORG, 30),
  };
}

/**
 * Validate one /api/generate body against the bounds.
 *
 * @param {any} body parsed request body
 * @param {{ maxPromptChars: number, maxTokens: number }} limits
 * @returns {{ ok: true, prompt: string, maxTokens: number | undefined }
 *   | { ok: false, status: 400 | 413, error: string }}
 */
export function resolveGenerateRequest(body, limits) {
  const prompt = body?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, status: 400, error: 'prompt is required' };
  if (prompt.length > limits.maxPromptChars) {
    return { ok: false, status: 413, error: `prompt exceeds ${limits.maxPromptChars} characters` };
  }
  const requested = body.max_tokens ?? body.maxTokens;
  if (requested === undefined || requested === null) return { ok: true, prompt, maxTokens: undefined };
  const tokens = Number(requested);
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return { ok: false, status: 400, error: 'max_tokens must be a positive integer' };
  return { ok: true, prompt, maxTokens: Math.min(tokens, limits.maxTokens) };
}

/**
 * Rate-limit bucket for /api/generate: its own per-organization bucket, so
 * generate traffic cannot drain the chat bucket and vice versa. A principal
 * with no organization is limited by user.
 *
 * @param {{ orgId?: string | null, userId?: string | null }} principal
 * @returns {string | null} bucket key, or null when the principal is unknown
 */
export function generateRateLimitKey({ orgId, userId }) {
  if (orgId) return `generate:org:${orgId}`;
  if (userId) return `generate:user:${userId}`;
  return null;
}

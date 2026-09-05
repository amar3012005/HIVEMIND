import { chatCompletionFetch } from '../../llm/chat-provider.js';
import { getStaticPromptArtifact } from '../chat-static-prompt-cache.js';
import { NATIVE_PLAN_TOOL_NAME, createNativePlanTool } from './planner-schema.js';
import { buildNativePlannerDynamicContext, buildNativePlannerPrompt, NATIVE_PLANNER_PROMPT_VERSION } from './planner-prompt.js';
import { validateNativePlanResult } from './plan-validator.js';

const PRIMARY = process.env.NATIVE_CHAT_V2_PLANNER_MODEL || 'google/gemini-2.5-flash';
const FALLBACK = process.env.NATIVE_CHAT_V2_PLANNER_FALLBACK_MODEL || 'google/gemini-2.5-flash';

export async function planNativeTurn({ context, apiKey, signal, fetchImpl, nativeMeta = false } = {}) {
  const stable = getStaticPromptArtifact({
    family: nativeMeta ? 'native-meta-v1' : 'native-chat-v2',
    version: nativeMeta ? `${NATIVE_PLANNER_PROMPT_VERSION}-meta1` : NATIVE_PLANNER_PROMPT_VERSION,
    build: () => `${buildNativePlannerPrompt()}${nativeMeta ? `\n\nNATIVE META RETRIEVAL CONTRACT\nPopulate retrieval from semantic intent. Preserve an explicit requested result count as retrieval.limit. Use memory_types/tags/scope/relationship filters only when the user explicitly requests that restriction. entity_filter_mode defaults to should; use must only for an exact entity-bounded request and off only when no entity restriction is intended. These are language-neutral structured controls.` : ''}`,
  });
  const messages = [
    { role: 'system', content: stable.value },
    { role: 'system', content: buildNativePlannerDynamicContext(context) },
    ...(context?.history || []),
    { role: 'user', content: context?.message || '' },
  ];
  // A structurally invalid plan is a provider failure too. Keep the retry on
  // the proven planner model by default; no second call occurs for a valid
  // plan, and the retry receives the exact validator error rather than
  // silently downgrading the whole turn to the legacy router.
  const models = [PRIMARY, FALLBACK].filter(Boolean);
  let lastError;
  let validationFeedback = null;
  for (let attempt = 0; attempt < models.length; attempt += 1) {
    const model = models[attempt];
    try {
      const attemptMessages = validationFeedback
        ? [...messages, { role: 'system', content: `Your previous tool payload was invalid: ${validationFeedback}. Return a corrected complete payload now.` }]
        : messages;
      const response = await chatCompletionFetch(model, {
        method: 'POST', signal, body: JSON.stringify({
          messages: attemptMessages, tools: [createNativePlanTool({ nativeMeta })],
          tool_choice: { type: 'function', function: { name: NATIVE_PLAN_TOOL_NAME } },
          parallel_tool_calls: false, temperature: 0, max_tokens: 850, prompt_cache_key: stable.key,
        }),
      }, { fallbackApiKey: apiKey, fetchImpl: fetchImpl || globalThis.fetch, useCase: 'chat_planner' });
      if (!response.ok) throw new Error(`native_v2_planner_${response.status}:${(await response.text()).slice(0, 200)}`);
      const data = await response.json();
      const call = data.choices?.[0]?.message?.tool_calls?.[0];
      if (call?.function?.name !== NATIVE_PLAN_TOOL_NAME) throw new Error('native_v2_missing_required_plan');
      const rawPlan = JSON.parse(call.function.arguments);
      const validation = validateNativePlanResult(rawPlan);
      if (validation.status === 'invalid') {
        validationFeedback = validation.error === 'native_plan_missing_profile_update'
          ? 'native_plan_missing_profile_update. Keep operation=update_profile and copy every changed caller-owned field into memory.profile_fields as field/value entries; do not leave it empty'
          : `${validation.error}. Reconsider the selected operation from the user's actual intent. If required semantic fields are absent, correct the operation instead of inventing write content or unrelated values`;
        throw new Error(`native_v2_invalid_plan:${validation.error}`);
      }
      return { rawPlan, usage: { ...(data.usage || {}), routing_model: model, routing_fallback_used: attempt > 0, routing_attempts: attempt + 1 } };
    } catch (error) {
      lastError = error;
      if (signal?.aborted) break;
    }
  }
  throw lastError || new Error('native_v2_planner_failed');
}

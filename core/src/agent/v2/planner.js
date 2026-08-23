import { chatCompletionFetch } from '../../llm/chat-provider.js';
import { getStaticPromptArtifact } from '../chat-static-prompt-cache.js';
import { NATIVE_PLAN_TOOL_NAME, createNativePlanTool } from './planner-schema.js';
import { buildNativePlannerDynamicContext, buildNativePlannerPrompt, NATIVE_PLANNER_PROMPT_VERSION } from './planner-prompt.js';

const PRIMARY = process.env.NATIVE_CHAT_V2_PLANNER_MODEL || 'google/gemini-2.5-flash';
const FALLBACK = process.env.NATIVE_CHAT_V2_PLANNER_FALLBACK_MODEL || 'openai/gpt-oss-20b:nitro';

export async function planNativeTurn({ context, apiKey, signal, fetchImpl } = {}) {
  const stable = getStaticPromptArtifact({ family: 'native-chat-v2', version: NATIVE_PLANNER_PROMPT_VERSION, build: buildNativePlannerPrompt });
  const messages = [
    { role: 'system', content: stable.value },
    { role: 'system', content: buildNativePlannerDynamicContext(context) },
    ...(context?.history || []),
    { role: 'user', content: context?.message || '' },
  ];
  const models = [...new Set([PRIMARY, FALLBACK].filter(Boolean))];
  let lastError;
  for (const model of models) {
    try {
      const response = await chatCompletionFetch(model, {
        method: 'POST', signal, body: JSON.stringify({
          messages, tools: [createNativePlanTool()],
          tool_choice: { type: 'function', function: { name: NATIVE_PLAN_TOOL_NAME } },
          parallel_tool_calls: false, temperature: 0, max_tokens: 850, prompt_cache_key: stable.key,
        }),
      }, { fallbackApiKey: apiKey, fetchImpl: fetchImpl || globalThis.fetch, useCase: 'chat_planner' });
      if (!response.ok) throw new Error(`native_v2_planner_${response.status}:${(await response.text()).slice(0, 200)}`);
      const data = await response.json();
      const call = data.choices?.[0]?.message?.tool_calls?.[0];
      if (call?.function?.name !== NATIVE_PLAN_TOOL_NAME) throw new Error('native_v2_missing_required_plan');
      return { rawPlan: JSON.parse(call.function.arguments), usage: { ...(data.usage || {}), routing_model: model, routing_fallback_used: model !== PRIMARY } };
    } catch (error) {
      lastError = error;
      if (signal?.aborted) break;
    }
  }
  throw lastError || new Error('native_v2_planner_failed');
}

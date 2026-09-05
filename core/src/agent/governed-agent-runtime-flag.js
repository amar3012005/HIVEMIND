/**
 * Dual, fail-closed admission gate for the LangGraph governed tools runtime.
 * Core must opt in and Cloudflare must have latched `full` for this turn.
 */
export const GOVERNED_LANGGRAPH_RUNTIME_FLAG = 'GOVERNED_LANGGRAPH_RUNTIME';

export function isGovernedLangGraphRuntimeEnabled(env = process.env, ctx = {}) {
  return String(env?.[GOVERNED_LANGGRAPH_RUNTIME_FLAG] || '').trim() === 'true'
    && ctx?.durableChatMode === 'full';
}

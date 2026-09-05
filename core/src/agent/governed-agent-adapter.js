import { runDurableComposioAgent } from './durable-composio-agent.js';
import { isGovernedLangGraphRuntimeEnabled } from './governed-agent-runtime-flag.js';

export async function runGovernedToolsAgent(input = {}) {
  const latchedResume = Boolean(input.ctx?.governedGraphThreadId);
  if (!latchedResume && !isGovernedLangGraphRuntimeEnabled(process.env, input.ctx)) {
    return runDurableComposioAgent(input);
  }
  const { runGovernedAgentRuntime } = await import('./governed-agent-runtime.js');
  try {
    return await runGovernedAgentRuntime(input);
  } catch (error) {
    // Checkpointer admission happens before connector execution. A cold-start
    // failure may safely degrade to the existing durable loop; a latched resume
    // must never fork into a second authority.
    if (!latchedResume && /langgraph_checkpoint|database|connect|ECONN/i.test(String(error?.message || error))) {
      input.onEvent?.({ type: 'agent_state', state: 'langgraph_unavailable_fallback', run_id: null });
      return runDurableComposioAgent(input);
    }
    throw error;
  }
}

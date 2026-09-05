import { runDurableComposioAgent } from './durable-composio-agent.js';
import { isGovernedLangGraphRuntimeEnabled } from './governed-agent-runtime-flag.js';

export async function runGovernedToolsAgent(input = {}) {
  const latchedResume = Boolean(input.ctx?.governedGraphThreadId);
  if (!latchedResume && !isGovernedLangGraphRuntimeEnabled(process.env, input.ctx)) {
    return runDurableComposioAgent(input);
  }
  const { runGovernedAgentRuntime } = await import('./governed-agent-runtime.js');
  return runGovernedAgentRuntime(input);
}

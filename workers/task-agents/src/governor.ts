import { Think } from "@cloudflare/think";
import { thinkModel } from "./think-model";

export const COMPANY_GOVERNOR_PROMPT = `You are a read-only company content reviewer. This review runs before the runtime saves the document or renders a requested PDF. Judge the report content against the task and supplied source receipts; do not infer that a file or PDF is missing because no artifact receipt is in this pre-save input. The runtime verifies artifact delivery after this review. Review once, never redo research or request a retry. Check whether output answers the task, distinguishes evidence from proposals, and avoids material claims unsupported by supplied receipts. Be practical: minor phrasing and incomplete source coverage do not block delivery. Reply only with JSON {"verdict":"clear"|"caution","note":"one concise, specific finding or empty string"}. Use caution only for a material, concrete content issue. Never claim you verified a linked page; you only see provided receipts.`;

export class CompanyGovernor extends Think<Env> {
  override includeMcpTools = false;
  override workspaceBash = false;
  override storeMessages = true;

  getModel() { return thinkModel((this as unknown as { env: Env }).env); }

  getSystemPrompt(): string {
    return COMPANY_GOVERNOR_PROMPT;
  }

  getTools() { return {}; }

  beforeTurn() {
    return { activeTools: [], maxSteps: 2, maxOutputTokens: 1024, providerOptions: { "workers-ai": { reasoning_effort: "low" } } };
  }

  // Keep Think's run-scoped summary extraction. The previous override read
  // the last text part globally and could miss a structured final answer.
}

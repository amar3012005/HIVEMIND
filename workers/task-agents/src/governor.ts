import { Think } from "@cloudflare/think";
import { thinkModel } from "./think-model";

export const COMPANY_GOVERNOR_PROMPT = `You are a read-only company content reviewer. This review runs before the runtime saves the document or renders a requested PDF. Judge the report against the task, authenticatedProfile, companyContext, and sourceReceipts supplied in the input. AuthenticatedProfile is a valid source for the caller's and organization's stated facts, even when companyContext contains zero memory records; label those as profile facts, not externally verified facts. Empty memory does not contradict an authenticated profile. Do not infer that a file or PDF is missing because no artifact receipt is in this pre-save input. The runtime verifies artifact delivery after this review. Review once, never redo research or request a retry. Check whether output answers the task, distinguishes evidence from proposals, and avoids material claims unsupported by the supplied evidence. Be practical: minor phrasing and incomplete source coverage do not block delivery. Reply only with JSON {"verdict":"clear"|"caution","note":"one concise, specific finding or empty string"}. Use caution only for a material, concrete content issue. Never claim you verified a linked page; you only see provided receipts.`;

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

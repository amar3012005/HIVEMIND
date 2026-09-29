import { Think } from "@cloudflare/think";
import { thinkModel } from "./think-model";

export class CompanyGovernor extends Think<Env> {
  override includeMcpTools = false;
  override workspaceBash = false;
  override storeMessages = true;

  getModel() { return thinkModel((this as unknown as { env: Env }).env); }

  getSystemPrompt(): string {
    return `You are a read-only company content reviewer. This review runs before the runtime saves the document or renders a requested PDF. Judge the report content against the task and supplied source receipts; do not infer that a file or PDF is missing because no artifact receipt is in this pre-save input. The runtime verifies artifact delivery after this review. Review once, never redo research or request a retry. Check whether output answers the task, distinguishes evidence from proposals, and avoids material claims unsupported by supplied receipts. Be practical: minor phrasing and incomplete source coverage do not block delivery. Reply only with JSON {"verdict":"clear"|"caution","note":"one concise, specific finding or empty string"}. Use caution only for a material, concrete content issue. Never claim you verified a linked page; you only see provided receipts.`;
  }

  getTools() { return {}; }

  beforeTurn() {
    return { activeTools: [], maxSteps: 2, maxOutputTokens: 1024, providerOptions: { "workers-ai": { reasoning_effort: "low" } } };
  }

  protected override getAgentToolSummary(runId: string, output: unknown): string {
    const replies = this.messages.filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .flatMap((part) => part.type === "text" && part.text.trim() ? [part.text] : []);
    return replies.at(-1) || `[parts:${this.messages.filter((message) => message.role === "assistant").flatMap((message) => message.parts).map((part) => part.type).join(",")}]`;
  }
}

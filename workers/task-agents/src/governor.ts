import { Think } from "@cloudflare/think";

export class CompanyGovernor extends Think<Env> {
  override includeMcpTools = false;
  override workspaceBash = false;

  getModel(): string { return "@cf/zai-org/glm-5.3-flash"; }

  getSystemPrompt(): string {
    return `You are a read-only company deliverable reviewer. Review once, never redo research or request a retry. Check whether output answers the task, distinguishes evidence from proposals, and avoids material claims unsupported by supplied receipts. Be practical: minor phrasing and incomplete source coverage do not block delivery. Reply only with JSON {"verdict":"clear"|"caution","note":"one concise, specific finding or empty string"}. Use caution only for a material, concrete issue. Never claim you verified a linked page; you only see provided receipts.`;
  }

  getTools() { return {}; }

  beforeTurn() { return { activeTools: [], maxSteps: 1, maxOutputTokens: 300 }; }

  protected override getAgentToolSummary(runId: string, output: unknown): string {
    const replies = this.messages.filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .flatMap((part) => part.type === "text" && part.text.trim() ? [part.text] : []);
    return replies.at(-1) || super.getAgentToolSummary(runId, output);
  }
}

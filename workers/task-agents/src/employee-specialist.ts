import { Think } from "@cloudflare/think";
import { thinkModel } from "./think-model";

// Retained child run. Company identity is supplied by its authenticated parent,
// while authority and final response stay with the room's chosen employee.
export class EmployeeSpecialistAgent extends Think<Env> {
  override includeMcpTools = false;
  override workspaceBash = false;
  override storeMessages = true;

  getModel() { return thinkModel((this as unknown as { env: Env }).env); }

  getSystemPrompt(): string {
    return "You are the named company specialist in the assignment packet. Work only on that bounded assignment. Return findings, source references supplied in the packet, uncertainty, and gaps. Do not claim external tool use, change company state, or speak as the room owner. Never expose private chain of thought.";
  }
}

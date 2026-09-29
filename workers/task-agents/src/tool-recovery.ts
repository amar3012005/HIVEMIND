const PROTOCOL_ERRORS = new Set(["AI_ToolChoiceViolationError", "AI_InvalidToolInputError", "AI_ToolCallRepairError"]);

export function repairBrowserExtractCall(toolName: string, input: string): { toolName: string; input: string } | null {
  if (toolName !== "browser_extract") return null;
  let value: unknown;
  try { value = JSON.parse(input); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const call = value as Record<string, unknown>;
  if (typeof call.url !== "string" || !/^https?:\/\//i.test(call.url) || call.prompt || call.schema) return null;
  return { toolName: "browser_markdown", input: JSON.stringify({ url: call.url }) };
}

export function mayRepairBrowserExtract(repairUsed: boolean, allowedTarget: boolean, priorReads: number): boolean {
  return !repairUsed && allowedTarget && priorReads === 0;
}

export function isRecoverableModelProtocolError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object") {
      const candidate = current as { name?: string; message?: string; cause?: unknown };
      if (candidate.name && PROTOCOL_ERRORS.has(candidate.name)) return true;
      if (candidate.message && /tool choice was required|think_final_answer|invalid tool input/i.test(candidate.message)) return true;
      current = candidate.cause;
    } else break;
  }
  return false;
}

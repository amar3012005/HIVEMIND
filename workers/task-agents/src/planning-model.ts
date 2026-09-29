export const OPERATING_PLAN_MARKER = "[hivemind:operating-plan-v1]";

export function isInitialOperatingPlan(messages: readonly { role: string; content: unknown }[], continuation: boolean): boolean {
  if (continuation) return false;
  const last = messages.at(-1);
  if (last?.role !== "user") return false;
  const content = last.content;
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((part) => part && typeof part === "object" && part.type === "text")
      .map((part) => part.text).filter((part): part is string => typeof part === "string").join("") : "";
  return text.startsWith(OPERATING_PLAN_MARKER);
}

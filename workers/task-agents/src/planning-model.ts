export const OPERATING_PLAN_MARKER = "[hivemind:operating-plan-v1]";

export function isInitialOperatingPlan(messages: readonly { role: string; content: unknown }[], _continuation: boolean): boolean {
  let lastUser: { role: string; content: unknown } | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      lastUser = messages[index];
      break;
    }
  }
  if (!lastUser) return false;
  const text = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => text(part)).join("");
    if (content && typeof content === "object") {
      const part = content as { type?: string; text?: unknown; parts?: unknown; content?: unknown };
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.parts) return text(part.parts);
      if (part.content) return text(part.content);
    }
    return "";
  };
  return text(lastUser.content).includes(OPERATING_PLAN_MARKER);
}

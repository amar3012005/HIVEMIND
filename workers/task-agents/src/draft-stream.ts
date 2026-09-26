import { parsePartialJson } from "ai";

export async function partialToolText(raw: string, field: "report" | "message"): Promise<string> {
  const parsed = await parsePartialJson(raw);
  const value = parsed.value;
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!record) return "";
  const text = field === "report" ? record.report ?? record.reply : record.message;
  return typeof text === "string" ? text : "";
}

import { parsePartialJson } from "ai";

export async function partialToolText(raw: string, field: "report" | "message"): Promise<string> {
  const parsed = await parsePartialJson(raw);
  const value = parsed.value;
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return record && typeof record[field] === "string"
    ? record[field]
    : "";
}

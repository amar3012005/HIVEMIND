export interface GovernanceVerdict {
  verdict: "clear" | "caution" | "unavailable";
  note: string;
}

export function parseGovernanceVerdict(value: string | undefined): GovernanceVerdict {
  const raw = value?.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "") ?? "";
  try {
    const result = JSON.parse(raw) as { verdict?: unknown; note?: unknown };
    if (result.verdict === "clear" || result.verdict === "caution") {
      return { verdict: result.verdict, note: typeof result.note === "string" ? result.note.trim().slice(0, 300) : "" };
    }
  } catch { /* Review failure stays advisory. */ }
  return { verdict: "unavailable", note: "Review unavailable; report delivered without model review." };
}

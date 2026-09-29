export interface GovernanceVerdict {
  verdict: "clear" | "caution" | "unavailable";
  note: string;
}

export function parseGovernanceVerdict(value: string | undefined): GovernanceVerdict {
  const raw = value?.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "") ?? "";
  try {
    const result = JSON.parse(raw) as { verdict?: unknown; note?: unknown };
    if (result.verdict === "clear" || result.verdict === "caution") {
      const note = typeof result.note === "string" ? result.note.trim() : "";
      const prefix = note.slice(0, 296);
      return { verdict: result.verdict, note: note.length > 300 ? `${prefix.slice(0, prefix.lastIndexOf(" ")).trimEnd()} …` : note };
    }
  } catch { /* Review failure stays advisory. */ }
  return { verdict: "unavailable", note: "Review unavailable; report delivered without model review." };
}

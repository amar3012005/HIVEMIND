type MemoryRow = { kind?: unknown; status?: unknown; agentSlug?: unknown; title?: unknown;
  summary?: unknown; runId?: unknown; createdAt?: unknown };

function rows(result: unknown): MemoryRow[] {
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true
    || !("memories" in result) || !Array.isArray(result.memories)) return [];
  return result.memories.slice(0, 5).filter((row): row is MemoryRow =>
    Boolean(row && typeof row === "object"));
}

function short(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Keep the automatic recall bounded; the full typed tool remains available on demand. */
export function operatingMemoryBrief(learnings: unknown, completed: unknown): string {
  const compact = [...rows(learnings), ...rows(completed)].map((row) => ({
    kind: short(row.kind, 24), status: short(row.status, 24), agent: short(row.agentSlug, 120),
    title: short(row.title, 150), summary: short(row.summary, 180),
    runId: short(row.runId, 80), at: short(row.createdAt, 40),
  })).filter((row) => row.title);
  return compact.length ? JSON.stringify(compact).slice(0, 3_500) : "";
}

type MemoryRow = { kind?: unknown; status?: unknown; agentSlug?: unknown; title?: unknown;
  summary?: unknown; runId?: unknown; createdAt?: unknown };

/** One idempotent event per terminal outcome; an incomplete attempt may later recover. */
export function operatingWorkStatusKey(runId: string, complete: boolean): string {
  return `workrun:${runId}:terminal:${complete ? "completed" : "incomplete"}`;
}

function rows(result: unknown): MemoryRow[] {
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true
    || !("memories" in result) || !Array.isArray(result.memories)) return [];
  return result.memories.filter((row): row is MemoryRow => Boolean(row && typeof row === "object"));
}

function short(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function trigrams(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  const result = new Set<string>();
  for (let index = 0; index + 3 <= normalized.length; index++) result.add(normalized.slice(index, index + 3));
  return result;
}

function relevance(query: Set<string>, row: MemoryRow): number {
  if (!query.size) return 0;
  const document = trigrams(`${short(row.title, 150)} ${short(row.summary, 300)}`);
  let matches = 0;
  for (const gram of query) if (document.has(gram)) matches++;
  return matches / query.size;
}

function similarity(left: string, right: string): number {
  const a = trigrams(left);
  const b = trigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return shared / Math.max(a.size, b.size);
}

function repeatedLesson(row: MemoryRow, retained: MemoryRow[]): boolean {
  return row.kind === "learning" && retained.some((prior) => prior.kind === "learning"
    && prior.agentSlug === row.agentSlug
    && similarity(short(prior.title, 150), short(row.title, 150)) >= 0.72
    && similarity(short(prior.summary, 500), short(row.summary, 500)) >= 0.62);
}

/** Recent records always survive; the remaining slots favor task-relevant, deduplicated memories. */
export function operatingMemoryBrief(results: readonly unknown[], task = ""): string {
  const unique = new Map<string, MemoryRow>();
  for (const row of results.flatMap(rows)) {
    const title = short(row.title, 150);
    if (!title) continue;
    const key = `${short(row.kind, 24)}:${title.normalize("NFKC").toLocaleLowerCase()}`;
    const previous = unique.get(key);
    if (!previous || short(row.createdAt, 40) > short(previous.createdAt, 40)) unique.set(key, row);
  }
  const ordered = [...unique.values()].sort((a, b) => short(b.createdAt, 40).localeCompare(short(a.createdAt, 40)))
    .filter((row, index, all) => !repeatedLesson(row, all.slice(0, index)));
  const chosen = new Set([...ordered.filter((row) => row.kind === "learning").slice(0, 2),
    ...ordered.filter((row) => row.kind === "task_status").slice(0, 2)]);
  const query = trigrams(short(task, 500));
  const candidates = ordered.filter((row) => !chosen.has(row)).sort((a, b) =>
    relevance(query, b) - relevance(query, a)
      || short(b.createdAt, 40).localeCompare(short(a.createdAt, 40)));
  for (const row of candidates.slice(0, Math.max(0, 6 - chosen.size))) chosen.add(row);
  const compact = [...chosen].sort((a, b) => short(b.createdAt, 40).localeCompare(short(a.createdAt, 40))).map((row) => ({
    kind: short(row.kind, 24), status: short(row.status, 24), agent: short(row.agentSlug, 60),
    title: short(row.title, 120), summary: short(row.summary, 150),
    runId: short(row.runId, 50), at: short(row.createdAt, 40),
  }));
  while (compact.length && JSON.stringify(compact).length > 3_500) compact.pop();
  return compact.length ? JSON.stringify(compact) : "";
}

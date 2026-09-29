import type { TraceEvent } from "./types";

type SessionTurn = { at: string; request: string; report?: string; outcome?: string; artifacts: string[] };

export function privateMemoryReceiptId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true
    || !("memory" in value) || !value.memory || typeof value.memory !== "object"
    || !("id" in value.memory) || typeof value.memory.id !== "string") return null;
  return value.memory.id;
}

export function verifiedPrivateLearning(entry: { title: string; summary: string; evidenceRef: string }, evidence: string): boolean {
  return entry.title.trim().length >= 8 && entry.summary.trim().length >= 30
    && entry.evidenceRef.trim().length >= 8 && evidence.includes(entry.evidenceRef.trim())
    && !/\b(?:Bearer|password|api[_-]?key|secret|token)\s*[:=]|\b(?:sk|rk|pk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{12,}/i.test(`${entry.title} ${entry.summary}`);
}

/** Give one model call bounded, receipt-bearing room history rather than a transcript dump. */
export function sessionMemoryEvidence(events: readonly TraceEvent[]): string {
  const current = events.map((event) => event.step).lastIndexOf("user");
  const prior = current < 0 ? events : events.slice(0, current);
  const turns: SessionTurn[] = [];
  for (const event of prior) {
    if (event.step === "user") {
      turns.push({ at: event.at, request: event.detail.slice(0, 600), artifacts: [] });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn) continue;
    if (event.step === "report") {
      const report = event.detail;
      turn.report = report.length <= 4400 ? report : `${report.slice(0, 2600)}\n[... middle omitted ...]\n${report.slice(-1700)}`;
    } else if (event.step === "completion") turn.outcome = event.detail.slice(0, 120);
    else if (event.step === "artifact") {
      try {
        const artifact = JSON.parse(event.detail) as { id?: string; kind?: string; title?: string };
        if (artifact.id && turn.artifacts.length < 5) turn.artifacts.push(`${artifact.kind || "artifact"}: ${artifact.title || "untitled"} (${artifact.id})`);
      } catch { /* malformed trace is not evidence */ }
    }
  }
  const selected: SessionTurn[] = [];
  let bytes = 0;
  for (const turn of turns.slice(-12).reverse()) {
    const length = JSON.stringify(turn).length;
    if (bytes + length > 18_000 && selected.length) break;
    selected.push(turn);
    bytes += length;
  }
  return JSON.stringify(selected.reverse());
}

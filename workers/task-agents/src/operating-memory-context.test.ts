import assert from "node:assert/strict";
import test from "node:test";
import { operatingMemoryBrief, operatingWorkStatusKey } from "./operating-memory-context.ts";

test("a recovered WorkRun can record completion without conflicting with its incomplete attempt", () => {
  const incomplete = operatingWorkStatusKey("run-1", false);
  const completed = operatingWorkStatusKey("run-1", true);
  assert.notEqual(incomplete, completed);
  assert.equal(operatingWorkStatusKey("run-1", false), incomplete);
  assert.equal(operatingWorkStatusKey("run-1", true), completed);
});

test("automatic operating recall is bounded and preserves typed newest-first records", () => {
  const result = { ok: true, memories: [{ kind: "learning", agentSlug: "marta", title: "New lesson",
    summary: "Verified reusable method", createdAt: "2026-09-29T10:00:00Z" }] };
  const brief = operatingMemoryBrief([result, { ok: true, memories: [{ kind: "task_status", status: "completed",
    agentSlug: "elena", title: "Prior task", summary: "Saved document", runId: "run-1" }] }]);
  assert.match(brief, /New lesson/);
  assert.match(brief, /Prior task/);
  assert.ok(brief.indexOf("New lesson") < brief.indexOf("Prior task"));
  assert.equal(operatingMemoryBrief([{ error: "unavailable" }, null]), "");
});

test("automatic recall orders completed work and lessons together by time", () => {
  const brief = operatingMemoryBrief([
    { ok: true, memories: [{ kind: "learning", title: "Older lesson", createdAt: "2026-09-29T08:00:00Z" }] },
    { ok: true, memories: [{ kind: "task_status", title: "Newer completion", createdAt: "2026-09-29T09:00:00Z" }] },
  ]);
  assert.ok(brief.indexOf("Newer completion") < brief.indexOf("Older lesson"));
});

test("automatic recall includes an older relevant correction without crowding out recent work", () => {
  const learningRows = Array.from({ length: 15 }, (_, index) => ({
    kind: "learning", title: `Routine note ${index}`, summary: "General handoff detail",
    createdAt: `2026-09-29T10:${String(index).padStart(2, "0")}:00Z`,
  }));
  learningRows.push({ kind: "learning", title: "Source quote verification", summary: "Check exact source passages before saving a report",
    createdAt: "2026-09-28T10:00:00Z" });
  learningRows.push({ ...learningRows.at(-1)!, createdAt: "2026-09-27T10:00:00Z" });
  const brief = operatingMemoryBrief([{ ok: true, memories: learningRows }, { ok: true, memories: [{
    kind: "task_status", title: "Latest finished task", status: "completed", createdAt: "2026-09-29T11:00:00Z",
  }] }], "Verify exact source passages in the report");
  const parsed = JSON.parse(brief) as { title: string }[];
  assert.ok(parsed.some((row) => row.title === "Source quote verification"));
  assert.ok(parsed.some((row) => row.title === "Latest finished task"));
  assert.equal(parsed.filter((row) => row.title === "Source quote verification").length, 1);
  assert.ok(brief.length <= 3_500);
});

test("task recall brings a relevant cross-employee decision and handoff into the bounded brief", () => {
  const brief = operatingMemoryBrief([
    { ok: true, memories: [{ kind: "learning", title: "General research method", summary: "Check sources", createdAt: "2026-09-29T11:00:00Z" }] },
    { ok: true, memories: [{ kind: "task_status", status: "completed", title: "Finished unrelated work", createdAt: "2026-09-29T10:00:00Z" }] },
    { ok: true, memories: [{ kind: "decision_note", agentSlug: "marta", title: "Berlin insurer approach decision", summary: "Use non-contact research first", createdAt: "2026-09-28T09:00:00Z" }] },
    { ok: true, memories: [{ kind: "handoff", agentSlug: "ravi", title: "Berlin insurer research handoff", summary: "Primary sources verified", createdAt: "2026-09-28T08:00:00Z" }] },
  ], "Continue Berlin insurer research");
  const records = JSON.parse(brief) as { kind: string; agent: string }[];
  assert.ok(records.some((row) => row.kind === "decision_note" && row.agent === "marta"));
  assert.ok(records.some((row) => row.kind === "handoff" && row.agent === "ravi"));
});

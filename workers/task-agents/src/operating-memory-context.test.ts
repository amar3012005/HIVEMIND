import assert from "node:assert/strict";
import test from "node:test";
import { operatingMemoryBrief } from "./operating-memory-context.ts";

test("automatic operating recall is bounded and preserves typed newest-first records", () => {
  const result = { ok: true, memories: [{ kind: "learning", agentSlug: "marta", title: "New lesson",
    summary: "Verified reusable method", createdAt: "2026-09-29T10:00:00Z" }] };
  const brief = operatingMemoryBrief(result, { ok: true, memories: [{ kind: "task_status", status: "completed",
    agentSlug: "elena", title: "Prior task", summary: "Saved document", runId: "run-1" }] });
  assert.match(brief, /New lesson/);
  assert.match(brief, /Prior task/);
  assert.ok(brief.indexOf("New lesson") < brief.indexOf("Prior task"));
  assert.equal(operatingMemoryBrief({ error: "unavailable" }, null), "");
});

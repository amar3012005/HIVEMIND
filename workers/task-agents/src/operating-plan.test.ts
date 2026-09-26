import assert from "node:assert/strict";
import test from "node:test";
import { missingPlanTaskIds, updatePlanTask } from "./operating-plan.ts";

test("updates only a task in the current run", () => {
  const plan = { runId: "run-1", summary: "Research", tasks: [{ id: 1, title: "Recall company", status: "pending" as const }] };
  assert.equal(updatePlanTask(plan, "run-2", 1, "completed"), null);
  assert.equal(updatePlanTask(plan, "run-1", 2, "completed"), null);
  assert.equal(updatePlanTask(plan, "run-1", 1, "completed")?.tasks[0].status, "completed");
  assert.equal(plan.tasks[0].status, "pending");
});

test("keeps a plan open while any planned task lacks completion evidence", () => {
  assert.deepEqual(missingPlanTaskIds(6, [1, 2]), [3, 4, 5, 6]);
  assert.deepEqual(missingPlanTaskIds(3, [3, 1, 2, 2]), []);
});

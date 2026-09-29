import assert from "node:assert/strict";
import test from "node:test";
import { completedPlanTaskIds, continuedPlan, currentTurnTasks, missingPlanTaskIds, updatePlanTask } from "./operating-plan.ts";

test("updates only a task in the current run", () => {
  const plan = { runId: "run-1", summary: "Research", tasks: [{ id: 1, title: "Recall company", status: "pending" as const }] };
  assert.equal(updatePlanTask(plan, "run-2", 1, "completed"), null);
  assert.equal(updatePlanTask(plan, "run-1", 2, "completed"), null);
  assert.equal(updatePlanTask(plan, "run-1", 1, "completed")?.tasks[0].status, "active");
  assert.equal(updatePlanTask(plan, "run-1", 1, "completed", true)?.tasks[0].status, "completed");
  assert.equal(plan.tasks[0].status, "pending");
});

test("final task stays active until validated report is saved", () => {
  const plan = { runId: "run-1", summary: "Campaign", tasks: [
    { id: 1, title: "Research", status: "pending" as const },
    { id: 2, title: "Write campaign", status: "pending" as const },
  ] };
  assert.equal(updatePlanTask(plan, "run-1", 1, "completed")?.tasks[0].status, "completed");
  assert.equal(updatePlanTask(plan, "run-1", 2, "completed")?.tasks[1].status, "active");
  assert.equal(updatePlanTask(plan, "run-1", 2, "completed", true)?.tasks[1].status, "completed");
});

test("keeps a plan open while any planned task lacks completion evidence", () => {
  assert.deepEqual(missingPlanTaskIds(6, [1, 2]), [3, 4, 5, 6]);
  assert.deepEqual(missingPlanTaskIds(3, [3, 1, 2, 2]), []);
});

test("uses completed tool-updated steps only from current run", () => {
  const plan = { runId: "run-1", summary: "Campaign", tasks: [
    { id: 1, title: "Research", status: "completed" as const },
    { id: 2, title: "Write", status: "active" as const },
  ] };
  assert.deepEqual(completedPlanTaskIds(plan, "run-1"), [1]);
  assert.deepEqual(completedPlanTaskIds(plan, "run-2"), []);
  assert.deepEqual(missingPlanTaskIds(2, completedPlanTaskIds(plan, "run-1")), [2]);
});

test("leaves post-approval work out of the current plan", () => {
  assert.deepEqual(currentTurnTasks(["Draft campaign direction", "Stop for operator approval", "On approval: draft channel assets"]), ["Draft campaign direction", "Stop for operator approval"]);
});

test("a continuation keeps completed steps and the operator's memory boundary", () => {
  const previous = { runId: "old", summary: "Research insurers", privateMemoryWritesAllowed: false, tasks: [
    { id: 1, title: "Verify sources", status: "completed" as const },
    { id: 2, title: "Write verified report", status: "active" as const },
  ] };
  const continued = continuedPlan("new", previous.summary, previous.tasks.map((task) => task.title), previous);
  assert.equal(continued.runId, "new");
  assert.equal(continued.privateMemoryWritesAllowed, false);
  assert.deepEqual(continued.tasks.map((task) => task.status), ["completed", "pending"]);
  assert.deepEqual(missingPlanTaskIds(continued.tasks.length, completedPlanTaskIds(continued, "new")), [2]);
  assert.deepEqual(continuedPlan("replacement", "New request", ["Different task"], previous).tasks.map((task) => task.status), ["pending"]);
  const falselyFinished = { ...previous, tasks: previous.tasks.map((task) => ({ ...task, status: "completed" as const })) };
  assert.deepEqual(continuedPlan("retry", previous.summary, falselyFinished.tasks.map((task) => task.title), falselyFinished).tasks.map((task) => task.status), ["completed", "pending"]);
});

test("a continuation carries only a contiguous completed prefix", () => {
  const previous = { runId: "old", summary: "Research", tasks: [
    { id: 1, title: "Find sources", status: "active" as const },
    { id: 2, title: "Verify", status: "completed" as const },
    { id: 3, title: "Save report", status: "pending" as const },
  ] };
  assert.deepEqual(continuedPlan("new", previous.summary, previous.tasks.map((task) => task.title), previous)
    .tasks.map((task) => task.status), ["pending", "pending", "pending"]);
});

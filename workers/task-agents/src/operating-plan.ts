import type { OperatingPlan, OperatingTask } from "./types";

export function updatePlanTask(plan: OperatingPlan | null | undefined, runId: string | undefined, id: number, status: OperatingTask["status"], verified = false): OperatingPlan | null {
  if (!plan || plan.runId !== runId || !plan.tasks.some((task) => task.id === id)) return null;
  if (status === "completed" && id === plan.tasks.at(-1)?.id && !verified) status = "active";
  return { ...plan, tasks: plan.tasks.map((task) => task.id === id ? { ...task, status } : task) };
}

export function missingPlanTaskIds(taskCount: number, completedTaskIds: readonly number[]): number[] {
  const completed = new Set(completedTaskIds);
  return Array.from({ length: taskCount }, (_, index) => index + 1).filter((id) => !completed.has(id));
}

export function currentTurnTasks(tasks: readonly string[]): string[] {
  return tasks.filter((task) => !/^\s*(?:on|after|upon|once)\s+(?:operator\s+)?approval\b/i.test(task));
}

import type { OperatingPlan, OperatingTask } from "./types";

export function updatePlanTask(plan: OperatingPlan | null | undefined, runId: string | undefined, id: number, status: OperatingTask["status"]): OperatingPlan | null {
  if (!plan || plan.runId !== runId || !plan.tasks.some((task) => task.id === id)) return null;
  return { ...plan, tasks: plan.tasks.map((task) => task.id === id ? { ...task, status } : task) };
}

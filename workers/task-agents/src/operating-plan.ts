import type { OperatingPlan, OperatingTask } from "./types";

export function updatePlanTask(plan: OperatingPlan | null | undefined, runId: string | undefined, id: number, status: OperatingTask["status"], verified = false): OperatingPlan | null {
  if (!plan || plan.runId !== runId || !plan.tasks.some((task) => task.id === id)) return null;
  if (status === "completed" && !verified) status = "active";
  return { ...plan, tasks: plan.tasks.map((task) => task.id === id ? { ...task, status } : task) };
}

function sourceIdentity(value: string): string {
  try {
    const url = new URL(value.replace(/[.,;:!?"'`]+$/u, ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return `${url.hostname.replace(/^www\./, "").toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
  } catch { return ""; }
}

/** A model may finish a source-read step only when every explicit URL in that
 * step has a current WorkRun page receipt. Other plan steps remain active until
 * the Workflow verifies their deliverable or tool receipt. */
export function planTaskSourceRequirements(title: string): string[] {
  return [...title.matchAll(/https?:\/\/[^\s<>)\]]+/g)]
    .map((match) => sourceIdentity(match[0])).filter(Boolean);
}

export function sourceReadPlanTaskVerified(title: string, receiptUrls: readonly string[]): boolean {
  const targets = planTaskSourceRequirements(title);
  if (!targets.length) return false;
  const receipts = new Set(receiptUrls.map(sourceIdentity).filter(Boolean));
  return targets.every((target) => receipts.has(target));
}

export function missingPlanTaskIds(taskCount: number, completedTaskIds: readonly number[]): number[] {
  const completed = new Set(completedTaskIds);
  return Array.from({ length: taskCount }, (_, index) => index + 1).filter((id) => !completed.has(id));
}

export function completedPlanTaskIds(plan: OperatingPlan | null | undefined, runId: string | undefined): number[] {
  if (!plan || plan.runId !== runId) return [];
  return plan.tasks.filter((task) => task.status === "completed").map((task) => task.id);
}

export function finalPlanStepReady(plan: OperatingPlan | null | undefined, runId: string | undefined): boolean {
  return !!plan && plan.runId === runId && plan.tasks.length > 1
    && plan.tasks.slice(0, -1).every((task) => task.status === "completed")
    && ["pending", "active"].includes(plan.tasks.at(-1)?.status ?? "");
}

export function currentTurnTasks(tasks: readonly string[]): string[] {
  return tasks.filter((task) => !/^\s*(?:on|after|upon|once)\s+(?:operator\s+)?approval\b/i.test(task));
}

export function continuedPlan(runId: string, summary: string, titles: readonly string[], previous?: OperatingPlan): OperatingPlan {
  let completedPrefix = 0;
  while (completedPrefix < titles.length - 1
    && previous?.tasks[completedPrefix]?.title === titles[completedPrefix]
    && previous.tasks[completedPrefix].status === "completed") completedPrefix += 1;
  return {
    runId,
    summary: summary.slice(0, 2000),
    privateMemoryWritesAllowed: previous?.privateMemoryWritesAllowed,
    tasks: titles.slice(0, 6).map((title, index) => ({
      id: index + 1,
      title: title.slice(0, 160),
      status: index < completedPrefix ? "completed" : "pending",
    })),
  };
}

import type { TaskAgentState } from "./types";

/** Small, current-run instructions appended to each model call after the stable prompt. */
export function runContext(state: TaskAgentState): string {
  const runId = state.envelope?.runId;
  if (!runId) return "";
  if (state.catalogStage === "planning") {
    return "Current phase: classify this request. Answer directly when the current conversation suffices; use a focused tool for a bounded lookup or action; use a company operating plan only for substantive company work. Choose the route from the request, not from a keyword. Do not load catalogs or start work until the route is chosen.";
  }
  const plan = state.operatingPlan?.runId === runId ? state.operatingPlan : null;
  const next = plan?.tasks.find((task) => task.status !== "completed");
  const mode = plan?.tasks.length ? "company" : "action";
  const lines = [
    `Current run ${runId}; route: ${mode}.`,
    state.companyContextRequired
      ? state.companyContextLoaded
        ? "Authenticated company context is available. Fetch a focused missing fact only when the next step needs it."
        : "Company context is not loaded. Use HIVEMIND before external work; do not invent company facts."
      : "Use the compact authenticated profile when sufficient; retrieve only missing context.",
  ];
  if (plan?.tasks.length) {
    lines.push(`Operating goal: ${plan.summary.slice(0, 300)}.`);
    lines.push(`Plan status: ${plan.tasks.map((task) => `${task.id}:${task.status}`).join(", ")}.`);
    lines.push(next
      ? `Next unfinished task ${next.id}: ${next.title}. Continue from its evidence and receipts; do not restart completed tasks.`
      : "All plan tasks appear done. Verify the requested output and its receipt before finalizing.");
  }
  if (state.activePlaybookId) {
    lines.push(`Pinned local method: ${state.activePlaybookId}. Its full body was loaded for this run. Do not select another playbook.`);
  }
  lines.push("Open only the tool family needed for the next step. The skill catalog gives names and descriptions; call activate_skill to load the full relevant method when that step begins. For connected apps, load composio-connected, discover the live connection and tool schema, respect approval, and rely on provider receipts. After a tool result, choose the next step from the result rather than repeating the previous call. Keep progress and plan status current. Never claim delegation, a saved artifact, a memory write, or a connected write without its receipt.");
  return lines.join("\n");
}

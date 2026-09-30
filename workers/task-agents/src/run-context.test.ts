import assert from "node:assert/strict";
import test from "node:test";
import { runContext } from "./run-context.ts";
import type { TaskAgentState } from "./types.ts";

function state(overrides: Partial<TaskAgentState> = {}): TaskAgentState {
  return {
    envelope: { runId: "run-2", orgId: "org", userId: "user", taskType: "task", phase: "run", inputRefs: [], outputSchemaId: "report" },
    role: "research", tools: [], events: [], places: [], sources: [], toolGroups: [],
    catalogStage: "action", selectedGlobals: [], workflowId: "", awaiting: "", operatingPlan: null,
    ...overrides,
  };
}

test("each company continuation receives only the current run's unfinished step and pinned method", () => {
  const context = runContext(state({
    activePlaybookId: "local:research.competitor-market",
    companyContextRequired: true,
    companyContextLoaded: true,
    operatingPlan: { runId: "run-2", summary: "Berlin competitors", tasks: [
      { id: 1, title: "Confirm company offer", status: "completed" },
      { id: 2, title: "Verify competitors", status: "active" },
      { id: 3, title: "Save report", status: "pending" },
    ] },
  }));
  assert.match(context, /Next unfinished task 2: Verify competitors/);
  assert.match(context, /Pinned local method: local:research.competitor-market/);
  assert.match(context, /activate_skill/);
  assert.match(context, /provider receipts/);
});

test("a new run cannot inherit a previous run's operating plan", () => {
  const context = runContext(state({
    operatingPlan: { runId: "run-1", summary: "Old task", tasks: [{ id: 1, title: "Old step", status: "pending" }] },
  }));
  assert.doesNotMatch(context, /Old task|Old step/);
  assert.match(context, /route: action/);
});

test("planning context keeps direct answers tool-free", () => {
  const context = runContext(state({ catalogStage: "planning", employee: {
    id: "employee-1", name: "Elena Kovács", slug: "elena-kov-cs", role: "Strategist", persona: "Product strategy lead",
  } }));
  assert.match(context, /Room owner: Elena Kovács/);
  assert.match(context, /Answer directly/);
  assert.match(context, /not from a keyword/);
  assert.doesNotMatch(context, /Pinned local method/);
});

test("prior WorkRun status is visible but cannot become the new turn's plan", () => {
  const context = runContext(state({ catalogStage: "planning", recoveryBrief: "run old; status incomplete; next unfinished step 2: Save report" }));
  assert.match(context, /Prior WorkRun receipt/);
  assert.match(context, /current request controls whether to continue/);
  assert.doesNotMatch(context, /Current run old/);
});

test("resumed execution sees exact saved source URLs without inheriting another plan", () => {
  const context = runContext(state({
    sourceReceiptBrief: "https://www.talanx.com/en/talanx-group, https://www.hannover-re.com/en/",
  }));
  assert.match(context, /Current WorkRun saved source URLs: https:\/\/www\.talanx\.com\/en\/talanx-group/);
  assert.match(context, /source_excerpt/);
  assert.doesNotMatch(context, /Old step/);
});

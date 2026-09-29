import assert from "node:assert/strict";
import test from "node:test";
import { isInitialOperatingPlan, OPERATING_PLAN_MARKER } from "./planning-model.ts";

test("fast model is limited to the first marked operating-plan call", () => {
  assert.equal(isInitialOperatingPlan([{ role: "user", content: `${OPERATING_PLAN_MARKER}\nPlan this request.` }], false), true);
  assert.equal(isInitialOperatingPlan([{ role: "user", content: [{ type: "text", text: `${OPERATING_PLAN_MARKER}\nPlan this request.` }] }], false), true);
  assert.equal(isInitialOperatingPlan([{ role: "user", content: `${OPERATING_PLAN_MARKER}\nPlan this request.` }], true), true);
  assert.equal(isInitialOperatingPlan([{ role: "user", content: { parts: [{ type: "text", text: `${OPERATING_PLAN_MARKER}\nPlan this request.` }] } }, { role: "assistant", content: "working" }], true), true);
  assert.equal(isInitialOperatingPlan([{ role: "user", content: `${OPERATING_PLAN_MARKER}\nOld request.` }, { role: "user", content: "Continue the work." }], false), false);
});

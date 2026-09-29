import assert from "node:assert/strict";
import test from "node:test";
import { workflowErrorCode } from "./workflow-error.ts";

test("classifies recoverable workflow failures without returning raw provider text", () => {
  assert.equal(workflowErrorCode(new Error("workrun_stopped")), "workrun_stopped");
  assert.equal(workflowErrorCode(new Error("8007: input 1052832 tokens is longer than model context length")), "model_context_limit");
  assert.equal(workflowErrorCode(new Error("fetch timed out after 20s")), "upstream_timeout");
  assert.equal(workflowErrorCode(new Error("429 rate limit")), "rate_limited");
  assert.equal(workflowErrorCode(new Error("secret bearer abc")), "workflow_failed");
});

test("classifies missing required structured calls as model output failures", () => {
  assert.equal(workflowErrorCode(new Error("AI_ToolChoiceViolationError: Model response did not contain a call to the required tool 'think_final_answer'.")), "model_output_invalid");
  assert.equal(workflowErrorCode(new Error("Think prompt returned invalid structured output")), "model_output_invalid");
});

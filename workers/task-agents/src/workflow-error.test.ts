import assert from "node:assert/strict";
import test from "node:test";
import { workflowErrorCode } from "./workflow-error.ts";

test("classifies recoverable workflow failures without returning raw provider text", () => {
  assert.equal(workflowErrorCode(new Error("8007: input 1052832 tokens is longer than model context length")), "model_context_limit");
  assert.equal(workflowErrorCode(new Error("fetch timed out after 20s")), "upstream_timeout");
  assert.equal(workflowErrorCode(new Error("429 rate limit")), "rate_limited");
  assert.equal(workflowErrorCode(new Error("secret bearer abc")), "workflow_failed");
});

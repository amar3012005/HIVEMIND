import assert from "node:assert/strict";
import test from "node:test";
import { verifiedExecutionReceipt } from "./execution-receipt.ts";

test("verified native plan steps produce a receipt without a second model call", () => {
  assert.deepEqual(verifiedExecutionReceipt("# Sourced report", [1, 2, 3], [1, 2, 3]),
    { report: "# Sourced report", completedTaskIds: [1, 2, 3] });
});

test("unfinished native plan steps cannot be projected as completed", () => {
  assert.equal(verifiedExecutionReceipt("# Draft", [1, 2], [1, 2, 3]), null);
  assert.equal(verifiedExecutionReceipt("", [1, 2, 3], [1, 2, 3]), null);
  assert.equal(verifiedExecutionReceipt("# Draft", [1], []), null);
});

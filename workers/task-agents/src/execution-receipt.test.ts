import assert from "node:assert/strict";
import test from "node:test";
import { verifiedExecutionReceipt } from "./execution-receipt.ts";

test("verified native plan steps produce a receipt without a second model call", () => {
  assert.deepEqual(verifiedExecutionReceipt("# Sourced report", [1, 2, 3], [1, 2, 3], [4], true),
    { report: "# Sourced report", completedTaskIds: [1, 2, 3, 4] });
});

test("unfinished native plan steps cannot be projected as completed", () => {
  assert.equal(verifiedExecutionReceipt("# Draft", [1, 2], [1, 2, 3]), null);
  assert.equal(verifiedExecutionReceipt("", [1, 2, 3], [1, 2, 3]), null);
  assert.equal(verifiedExecutionReceipt("# Draft", [1], []), null);
  assert.equal(verifiedExecutionReceipt("# Draft", [1, 2], [1, 2], [3], false), null);
});

test("an unplanned action uses native answer only when its deliverable is ready", () => {
  assert.deepEqual(verifiedExecutionReceipt("Completed answer", [], [], [], true, true),
    { report: "Completed answer", completedTaskIds: [] });
  assert.equal(verifiedExecutionReceipt("# Unfinished draft", [], [], [], false, true), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mergeReportProgress } from "./report-progress.ts";

test("an empty continuation preserves report, verified rows, and completed work", () => {
  const previous = { needsInput: false, question: "", options: [], report: "# Verified brief\nEvidence",
    completedTaskIds: [1, 2, 3], operatingLearnings: [], prospects: [{ locationUrl: "https://example.com/imprint", name: "Example" }] };
  const next = { needsInput: false, question: "", options: [], report: "", completedTaskIds: [], operatingLearnings: [], prospects: [] };
  assert.deepEqual(mergeReportProgress(previous, next), previous);
});

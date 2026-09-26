import assert from "node:assert/strict";
import test from "node:test";
import { parseGovernanceVerdict } from "./governor-verdict.ts";

test("governor review is bounded and advisory", () => {
  assert.deepEqual(parseGovernanceVerdict('{"verdict":"clear","note":""}'), { verdict: "clear", note: "" });
  assert.deepEqual(parseGovernanceVerdict('```json\n{"verdict":"caution","note":"Target lacks baseline."}\n```'), { verdict: "caution", note: "Target lacks baseline." });
  assert.equal(parseGovernanceVerdict("not JSON").verdict, "unavailable");
});

import assert from "node:assert/strict";
import test from "node:test";
import { parseGovernanceVerdict } from "./governor-verdict.ts";

test("governor review is bounded and advisory", () => {
  assert.deepEqual(parseGovernanceVerdict('{"verdict":"clear","note":""}'), { verdict: "clear", note: "" });
  assert.deepEqual(parseGovernanceVerdict('```json\n{"verdict":"caution","note":"Target lacks baseline."}\n```'), { verdict: "caution", note: "Target lacks baseline." });
  const bounded = parseGovernanceVerdict(JSON.stringify({ verdict: "caution", note: `${"Evidence was incomplete. ".repeat(20)}More detail.` }));
  assert.ok(bounded.note.length <= 300);
  assert.match(bounded.note, /…$/);
  assert.doesNotMatch(bounded.note, /\w…$/);
  assert.equal(parseGovernanceVerdict("not JSON").verdict, "unavailable");
});

import assert from "node:assert/strict";
import test from "node:test";
import { privateMemoryReceiptId, sessionMemoryEvidence } from "./session-memory.ts";

test("private-memory save uses the nested Control receipt", () => {
  assert.equal(privateMemoryReceiptId({ ok: true, memory: { id: "saved-1" } }), "saved-1");
  assert.equal(privateMemoryReceiptId({ ok: true, id: "wrong-shape" }), null);
  assert.equal(privateMemoryReceiptId({ ok: false, memory: { id: "unsaved" } }), null);
});

test("session handoff excludes current request and preserves outcome and artifact receipts", () => {
  const history = sessionMemoryEvidence([
    { at: "1", step: "user", detail: "Research revenue models" },
    { at: "2", step: "report", detail: "# Revenue models\nVerified pricing comparison" },
    { at: "3", step: "artifact", detail: JSON.stringify({ id: "art-1", kind: "report", title: "Revenue models" }) },
    { at: "4", step: "completion", detail: "deliverable_ready" },
    { at: "5", step: "user", detail: "Save this session in the agent brain" },
  ]);
  assert.match(history, /Verified pricing comparison/);
  assert.match(history, /art-1/);
  assert.match(history, /deliverable_ready/);
  assert.doesNotMatch(history, /Save this session/);
});

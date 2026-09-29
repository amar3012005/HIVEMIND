import assert from "node:assert/strict";
import test from "node:test";
import { isRecoverableModelProtocolError, repairBrowserExtractCall } from "./tool-recovery.ts";

test("repairs URL-only browser extraction into a page read", () => {
  assert.deepEqual(repairBrowserExtractCall("browser_extract", '{"url":"https://example.com/imprint"}'), {
    toolName: "browser_markdown", input: '{"url":"https://example.com/imprint"}',
  });
  assert.equal(repairBrowserExtractCall("browser_extract", '{"url":"https://example.com","prompt":"Find address"}'), null);
  assert.equal(repairBrowserExtractCall("browser_extract", '{"url":"file:///secret"}'), null);
});

test("identifies only model protocol errors through wrappers", () => {
  assert.equal(isRecoverableModelProtocolError(new Error("failed", { cause: Object.assign(new Error("tool choice was required"), { name: "AI_ToolChoiceViolationError" }) })), true);
  assert.equal(isRecoverableModelProtocolError(new Error("network offline")), false);
});

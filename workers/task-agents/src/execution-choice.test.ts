import assert from "node:assert/strict";
import test from "node:test";
import { isNonblockingExecutionChoice, READ_TOOL_FALLBACK } from "./execution-choice.ts";

test("read guidance discovers unknown URLs before browser reads", () => {
  assert.match(READ_TOOL_FALLBACK, /exact URL returned by parallel_search/);
  assert.match(READ_TOOL_FALLBACK, /exact same-site link in a page already read/);
  assert.match(READ_TOOL_FALLBACK, /Read a URL supplied by the operator directly/);
  assert.doesNotMatch(READ_TOOL_FALLBACK, /browser_markdown with the exact public HTTPS URL first/);
});

test("browser tool choice is an internal execution decision", () => {
  assert.equal(isNonblockingExecutionChoice("Do you want me to fetch the pages using browser_extract with the required URL parameter, or fall back to browser_markdown?", ["Use browser_extract", "Use browser_markdown"]), true);
  assert.equal(isNonblockingExecutionChoice("Which browser tool should I use?", ["browser_markdown", "browser_extract"]), true);
  assert.equal(isNonblockingExecutionChoice("Would you like me to proceed with the report?", ["Yes", "No"]), true);
  assert.equal(isNonblockingExecutionChoice("Should I retry the public page fetch?", ["Retry", "Stop"]), true);
  assert.equal(isNonblockingExecutionChoice("Which should I use?", []), true);
  assert.equal(isNonblockingExecutionChoice("", []), true);
});

test("authorization and missing task inputs still require the operator", () => {
  assert.equal(isNonblockingExecutionChoice("May I send the draft to this recipient?", ["Send it", "Do not send"]), false);
  assert.equal(isNonblockingExecutionChoice("Which recipient should receive the report?", ["Alice", "Bob"]), false);
  assert.equal(isNonblockingExecutionChoice("Which recipient should receive the report?", []), false);
  assert.equal(isNonblockingExecutionChoice("Which product should this comparison cover?", ["Product A", "Product B"]), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { browserTargetAllowed } from "./source-discovery.ts";

test("browser reads require an exact discovered or user-provided URL", () => {
  const found = new Set(["https://example.com/imprint"]);
  assert.equal(browserTargetAllowed("https://example.com/imprint", found, []), true);
  assert.equal(browserTargetAllowed("https://example.com/guessed-page", found, []), false);
  assert.equal(browserTargetAllowed("https://example.com/report", found, ["Read https://example.com/report."]), true);
  assert.equal(browserTargetAllowed("https://example.com/other", found, ["Read https://example.com/report."]), false);
});

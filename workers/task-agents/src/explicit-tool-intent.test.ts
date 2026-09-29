import assert from "node:assert/strict";
import test from "node:test";
import { explicitToolGroups } from "./explicit-tool-intent.ts";

test("an explicit research and browser call opens the required tool families", () => {
  assert.deepEqual(explicitToolGroups("Use parallel_search, then call browser_markdown on its exact returned URL."), ["web_research", "browser"]);
  assert.deepEqual(explicitToolGroups("Answer directly; do not use connected apps."), []);
  assert.deepEqual(explicitToolGroups("Do not call browser_markdown; call parallel_search."), ["web_research"]);
});

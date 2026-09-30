import assert from "node:assert/strict";
import test from "node:test";
import { sourceContext } from "./source-context.ts";

test("source context keeps exact matching passages while bounding page history", () => {
  const page = `# Example insurer\n${"General navigation and products.\n".repeat(250)}\nHQ: Hannover, Germany. We provide commercial insurance.\n${"Investor updates.\n".repeat(250)}`;
  const view = sourceContext(page, "Hannover commercial insurance", 2200);
  assert.match(view, /HQ: Hannover, Germany\. We provide commercial insurance\./);
  assert.ok(view.length <= 2200);
  assert.ok(view.length < page.length / 2);
});

test("source context retains both ends when a query has no match", () => {
  const page = `Start of source\n${"unrelated filler ".repeat(400)}\nEnd of source`;
  const view = sourceContext(page, "no matching phrase", 1400);
  assert.match(view, /Start of source/);
  assert.match(view, /End of source/);
  assert.ok(view.length <= 1400);
});

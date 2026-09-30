import assert from "node:assert/strict";
import test from "node:test";
import { sourceExcerpt, sourcePreview } from "./source-preview.ts";

test("large source preview keeps task evidence and footer within budget", () => {
  const page = ["# Insurer profile", ...Array.from({ length: 400 }, (_, i) => `Unrelated navigation item ${i}: lorem ipsum dolor sit amet`),
    "Hannover location: HDI-Platz 1, 30659 Hannover.", "Insurance business: commercial insurer.",
    ...Array.from({ length: 400 }, (_, i) => `Unrelated footer item ${i}: lorem ipsum dolor sit amet`),
    "Legal imprint: HDI-Platz 1, 30659 Hannover."].join("\n");
  const preview = sourcePreview(page, "Verify Hannover location and commercial insurer business", 2500);
  assert.ok(preview.length <= 2500);
  assert.match(preview, /Hannover location: HDI-Platz 1/);
  assert.match(preview, /Insurance business: commercial insurer/);
  assert.match(preview, /Legal imprint: HDI-Platz 1/);
  assert.match(sourceExcerpt(page, "HDI-Platz 1") ?? "", /Hannover location: HDI-Platz 1/);
  assert.equal(sourceExcerpt(page, "nonexistent exact phrase"), null);
});

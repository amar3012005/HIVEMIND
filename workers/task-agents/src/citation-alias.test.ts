import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeReadCitationAliases } from "./completion.ts";

test("unambiguous wildcard citations resolve to exact WorkRun page receipts", () => {
  assert.equal(canonicalizeReadCitationAliases(
    "Read https://singulancelabs.com/** and https://deepset.ai/**.",
    ["https://singulancelabs.com/", "https://www.deepset.ai/"],
  ), "Read https://singulancelabs.com/ and https://www.deepset.ai/.");
});

test("unread or ambiguous citations remain unverified", () => {
  const report = "See https://example.com/** and https://unknown.test/** and https://example.com/imprint.";
  assert.equal(canonicalizeReadCitationAliases(report,
    ["https://example.com/", "https://example.com/about"]), report);
});

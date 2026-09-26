import assert from "node:assert/strict";
import test from "node:test";
import { toolkitSkillManifest } from "./skill-catalog.ts";

test("publishes the four toolkit skills", () => {
  const manifest = toolkitSkillManifest();
  assert.deepEqual(manifest.skills.map((skill) => skill.name), [
    "hivemind-meta",
    "report-render",
    "outreach-email",
    "prospect-qualification",
    "social-draft",
    "engineering-change",
    "customer-report",
    "strategy-scenarios",
    "seo-audit",
    "brand-expression",
    "fundraising-narrative",
    "product-brief",
    "design-artifact",
    "legal-memo",
    "finance-brief",
    "composio-connected",
    "parallel-search",
    "browser-use",
  ]);
  for (const skill of manifest.skills) {
    assert.ok(skill.description.length > 20);
    assert.ok(skill.body.includes("- "));
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { toolkitSkillManifest } from "./skill-catalog.ts";
import { toolsForGroups } from "./tool-groups.ts";

test("company tools cannot prepare an unsolicited memory write", () => {
  assert.ok(!toolsForGroups(["company"]).includes("save_memory"));
});

test("native meta and connected gateways stay available across tool groups", () => {
  for (const groups of [[], ["company"], ["browser"], ["connected_apps"]]) {
    const names = toolsForGroups(groups);
    assert.ok(names.includes("hivemind_meta"));
    assert.ok(names.includes("hivemind_connected_task"));
  }
  assert.ok(!toolsForGroups(["connected_apps"]).includes("composio_discover_reads"));
  assert.ok(!toolsForGroups(["connected_apps"]).includes("composio_read"));
});

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

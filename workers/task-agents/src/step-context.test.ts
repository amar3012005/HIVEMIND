import assert from "node:assert/strict";
import test from "node:test";
import type { ModelMessage } from "ai";
import { compactPageForStep, compactStepSourceMessages } from "./step-context.ts";

test("native step context keeps exact task passages and a late legal address", () => {
  const page = `# Company\nWe provide corporate insurance.\n${"Unrelated navigation. ".repeat(500)}\nOur digital transformation team uses AI.\n${"Other links. ".repeat(500)}\nHDI-Platz 1, 30659 Hannover`;
  const excerpt = compactPageForStep(page, "Verify Hannover insurance and digital transformation", 5500);
  assert.ok(excerpt.length < page.length);
  assert.match(excerpt, /corporate insurance/);
  assert.match(excerpt, /digital transformation/);
  assert.match(excerpt, /30659 Hannover/);
});

test("native step context preserves tool result IDs and leaves non-browser results alone", () => {
  const page = `# Company\n${"Navigation. ".repeat(1000)}\nInsurance headquarters in Hannover.`;
  const messages: ModelMessage[] = [
    { role: "user", content: "Research the insurer" },
    { role: "tool", content: [
      { type: "tool-result", toolCallId: "read-1", toolName: "browser_markdown", output: { type: "json", value: { url: "https://example.com", markdown: page } } },
      { type: "tool-result", toolCallId: "plan-1", toolName: "update_plan_task", output: { type: "json", value: { updated: true } } },
    ] },
  ];
  const result = compactStepSourceMessages(messages, "Hannover insurance");
  assert.equal(result[0], messages[0]);
  assert.equal(result[1].role, "tool");
  if (result[1].role !== "tool") return;
  const read = result[1].content[0];
  assert.equal(read.toolCallId, "read-1");
  assert.equal(read.output.type, "json");
  if (read.output.type !== "json" || !read.output.value || typeof read.output.value !== "object" || Array.isArray(read.output.value)) return;
  assert.equal(read.output.value.url, "https://example.com");
  assert.ok(String(read.output.value.markdown).length < page.length);
  assert.equal(result[1].content[1], messages[1].role === "tool" ? messages[1].content[1] : null);
});

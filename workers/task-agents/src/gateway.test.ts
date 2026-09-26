import assert from "node:assert/strict";
import test from "node:test";
import { parallelSearch, readCompanyProfile } from "./gateway.ts";
import { toolsForGroups } from "./tool-groups.ts";

test("company catalog exposes working memory and profile routes", () => {
  const names = toolsForGroups(["company"]);
  assert.ok(names.includes("hivemind_recall"));
  assert.ok(names.includes("get_user_profile"));
  assert.ok(!names.includes("hivemind_get_memory"));
});

test("company profile reads Core under sealed identity", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://core.example/api/profiles");
    assert.equal((init?.headers as Record<string, string>)["x-hm-org-id"], "org-1");
    assert.equal((init?.headers as Record<string, string>)["x-hm-user-id"], "user-1");
    return Response.json({ name: "SINGULANCE" });
  };
  try {
    assert.deepEqual(await readCompanyProfile({ HIVEMIND_CORE_URL: "https://core.example", HIVEMIND_MASTER_API_KEY: "test" }, "org-1", "user-1"), { name: "SINGULANCE" });
  } finally {
    globalThis.fetch = original;
  }
});

test("parallel search uses direct AI Gateway route and keeps URL evidence", async () => {
  const original = globalThis.fetch;
  let called = "";
  globalThis.fetch = async (input, init) => {
    called = String(input);
    assert.equal((init?.headers as Record<string, string>)["x-api-key"], "test-token");
    return Response.json({ results: [
      { title: "Candidate", url: "https://candidate.example", text: "Hannover office" },
      { title: "Unsupported", url: "", text: "No source" },
    ] });
  };
  try {
    const result = await parallelSearch({ CLOUDFLARE_ACCOUNT_ID: "account", AI_GATEWAY_ID: "gateway", CLOUDFLARE_AI_GATEWAY_TOKEN: "test-token" }, "Hannover prospects");
    assert.match(called, /\/parallel\/v1beta\/search$/);
    assert.deepEqual(result, { provider: "parallel-ai-gateway", results: [{ title: "Candidate", url: "https://candidate.example", snippet: "Hannover office" }] });
  } finally {
    globalThis.fetch = original;
  }
});

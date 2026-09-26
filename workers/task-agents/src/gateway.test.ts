import assert from "node:assert/strict";
import test from "node:test";
import { parallelSearch } from "./gateway.ts";

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

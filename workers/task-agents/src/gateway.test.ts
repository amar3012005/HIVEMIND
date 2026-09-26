import assert from "node:assert/strict";
import test from "node:test";
import { parallelSearch, readCompanyProfile, readCompactProfile, readMetaEntities, readMetaRecall, saveCompanyMemory } from "./gateway.ts";
import { toolsForGroups } from "./tool-groups.ts";

test("company catalog exposes native memory gateway", () => {
  const names = toolsForGroups(["company"]);
  assert.ok(names.includes("hivemind_meta"));
  assert.ok(!names.includes("hivemind_recall"));
  assert.ok(!names.includes("get_user_profile"));
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

test("compact profile and scoped meta reads use authenticated Core identity", async () => {
  const original = globalThis.fetch;
  const called: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    called.push(url);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["x-hm-org-id"], "org-1");
    assert.equal(headers["x-hm-user-id"], "user-1");
    if (url.endsWith("/api/profiles/context")) return Response.json({ context: "Company: Example" });
    if (url.includes("/api/entities?")) return Response.json({ items: [{ id: "e-1", canonicalName: "Ada", entityKind: "person" }], total: 1 });
    assert.deepEqual(JSON.parse(String(init?.body)), { query_context: "Ada decision", max_memories: 5, mode: "auto", scope_filter: "personal" });
    return Response.json({ memories: [{ id: "m-1", title: "Decision", content: "Evidence" }] });
  };
  const env = { HIVEMIND_CORE_URL: "https://core.example", HIVEMIND_MASTER_API_KEY: "test" };
  try {
    assert.deepEqual(await readCompactProfile(env, "org-1", "user-1"), { context: "Company: Example" });
    assert.deepEqual(await readMetaEntities(env, "org-1", "user-1", "Ada", 10), { items: [{ id: "e-1", name: "Ada", kind: "person", aliases: undefined }], total: 1 });
    assert.deepEqual(await readMetaRecall(env, "org-1", "user-1", { query: "Ada decision", scopeFilter: "personal" }), { ok: true, count: 1, scoped: true, memories: [{ id: "m-1", title: "Decision", content: "Evidence", source: undefined, citation: undefined, createdAt: undefined, validAt: undefined }] });
    assert.equal(called.length, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test("memory save carries scope and idempotency and does not call pending saved", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://core.example/api/memories?sync=true");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["x-idempotency-key"], "save-1");
    assert.deepEqual(JSON.parse(String(init?.body)).scope, "personal");
    return Response.json({ status: "executing" }, { status: 202 });
  };
  try {
    assert.deepEqual(await saveCompanyMemory({ HIVEMIND_CORE_URL: "https://core.example", HIVEMIND_MASTER_API_KEY: "test" }, "org-1", "user-1", "Title", "Content", { scope: "personal", idempotencyKey: "save-1" }), { ok: false, status: "pending", payload: { status: "executing" }, idempotencyKey: "save-1" });
  } finally {
    globalThis.fetch = original;
  }
});

test("memory save reports completion only after synchronous Core receipt", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, id: "memory-1" }, { status: 201 });
  try {
    assert.deepEqual(await saveCompanyMemory({ HIVEMIND_CORE_URL: "https://core.example", HIVEMIND_MASTER_API_KEY: "test" }, "org-1", "user-1", "Operator name: Amar", "Operator's preferred name is Amar.", { scope: "personal", idempotencyKey: "save-2" }), { ok: true, status: "completed", payload: { success: true, id: "memory-1" }, idempotencyKey: "save-2" });
  } finally {
    globalThis.fetch = original;
  }
});

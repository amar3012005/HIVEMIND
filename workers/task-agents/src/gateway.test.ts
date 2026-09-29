import assert from "node:assert/strict";
import test from "node:test";
import { confirmedCompanyMemoryId, parallelSearch, parallelSearchBatch, readCompanyProfile, readCompactProfile, readMetaEntities, readMetaRecall, recallOperatingMemory, saveCompanyMemory, saveOperatingMemory } from "./gateway.ts";
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

test("batch search runs concurrently and preserves partial failures", async () => {
  const original = globalThis.fetch;
  let active = 0;
  let peak = 0;
  globalThis.fetch = async (_input, init) => {
    const query = JSON.parse(String(init?.body)).objective as string;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (query === "failed") return Response.json({}, { status: 502 });
    return Response.json({ results: [{ title: query, url: `https://${query}.example`, text: "Source" }] });
  };
  try {
    const result = await parallelSearchBatch({ CLOUDFLARE_ACCOUNT_ID: "account", AI_GATEWAY_ID: "gateway", CLOUDFLARE_AI_GATEWAY_TOKEN: "test-token" }, ["one", "two", "failed", "four"]);
    assert.equal(peak, 4);
    assert.equal(result.searches.length, 4);
    assert.equal(result.searches[0]?.results[0]?.url, "https://one.example");
    assert.equal(result.searches[2]?.error, "parallel_search_failed");
    assert.equal(result.searches[3]?.results[0]?.url, "https://four.example");
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
    const body = JSON.parse(String(init?.body));
    assert.equal(body.scope, "personal");
    assert.equal(body.source_platform, "hyperagent");
    assert.equal(body.source_session_id, "run-1");
    assert.ok(body.tags.includes("hyperagent"));
    return Response.json({ status: "executing" }, { status: 202 });
  };
  try {
    assert.deepEqual(await saveCompanyMemory({ HIVEMIND_CORE_URL: "https://core.example", HIVEMIND_MASTER_API_KEY: "test" }, "org-1", "user-1", "Title", "Content", { scope: "personal", idempotencyKey: "save-1", sessionId: "run-1" }), { ok: false, status: "pending", payload: { status: "executing" }, idempotencyKey: "save-1" });
  } finally {
    globalThis.fetch = original;
  }
});

test("HyperAgent recall filters by source and requests newest first", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), {
      query_context: "recent decisions and completed work", max_memories: 20, mode: "auto",
      source_platforms: ["hyperagent"], sort: "date_desc",
    });
    return Response.json({ memories: [
      { id: "m-0", title: "Other source", source_platform: "api", created_at: "2026-09-27T12:00:00Z" },
      { id: "m-1", title: "Decision", content: "Approved direction", source_platform: "hyperagent", created_at: "2026-09-26T12:00:00Z" },
      { id: "m-2", title: "New decision", content: "Next direction", source_platform: "hyperagent", created_at: "2026-09-27T10:00:00Z" },
    ] });
  };
  try {
    assert.deepEqual(await readMetaRecall({ HIVEMIND_CORE_URL: "https://core.example", HIVEMIND_MASTER_API_KEY: "test" }, "org-1", "user-1", {
      query: "recent decisions and completed work", sourcePlatforms: ["hyperagent"], sort: "date_desc",
    }), { ok: true, count: 2, scoped: true, memories: [
      { id: "m-2", title: "New decision", content: "Next direction", source: "hyperagent", citation: undefined, createdAt: "2026-09-27T10:00:00Z", validAt: undefined },
      { id: "m-1", title: "Decision", content: "Approved direction", source: "hyperagent", citation: undefined, createdAt: "2026-09-26T12:00:00Z", validAt: undefined },
    ] });
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

test("company-memory completion requires Core's persisted memory id", () => {
  assert.equal(confirmedCompanyMemoryId({ ok: true, status: "completed", payload: { success: true, memory: { id: "memory-1" } } }), "memory-1");
  assert.equal(confirmedCompanyMemoryId({ ok: true, status: "completed", payload: { success: true } }), "");
  assert.equal(confirmedCompanyMemoryId({ ok: false, status: "pending", payload: { memory: { id: "memory-1" } } }), "");
  assert.equal(confirmedCompanyMemoryId({ ok: true, status: "completed", payload: { success: true, skipped: true } }), "");
});

test("Hyper Agents memory uses only the sealed internal Control Plane route", async () => {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://control.example/internal/hyper/operating-memory");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer test");
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, memories: [] });
  };
  const env = { HIVEMIND_CONTROL_URL: "https://control.example", HIVEMIND_MASTER_API_KEY: "test" };
  try {
    await saveOperatingMemory(env, "org-1", "user-1", { kind: "learning", status: "recorded", agent_slug: "elena", title: "Lesson", summary: "Check receipts", idempotency_key: "run-1:lesson" });
    await recallOperatingMemory(env, "org-1", "user-1", { kind: "task_status", status: "completed", limit: 5 });
    assert.deepEqual(bodies[0], { action: "save", org_id: "org-1", user_id: "user-1", kind: "learning", status: "recorded", agent_slug: "elena", title: "Lesson", summary: "Check receipts", idempotency_key: "run-1:lesson" });
    assert.deepEqual(bodies[1], { action: "recall", org_id: "org-1", user_id: "user-1", kind: "task_status", status: "completed", limit: 5 });
  } finally {
    globalThis.fetch = original;
  }
});

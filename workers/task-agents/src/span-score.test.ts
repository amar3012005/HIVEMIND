import assert from "node:assert/strict";
import test from "node:test";
import { parseSpanScore, scoreCompanyBehavior } from "./span-score.ts";

const ids = ["unsupported_claims", "unfinished_plan", "unrequested_action", "misleading_failure"];

test("Span-01 sends one bounded, multi-behavior decision directly to OpenRouter", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (request, init) => {
    calls += 1;
    assert.equal(String(request), "https://openrouter.ai/api/alpha/decisions");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer openrouter-test-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "respan/span-01");
    assert.deepEqual(Object.keys(body.questions), ids);
    const context = JSON.parse(body.state.input[0].content);
    assert.equal(context.completed_task_ids[0], 1);
    assert.equal(context.tool_receipts[0].step, "parallel_search");
    assert.equal(context.tool_receipts.some((receipt: { step: string }) => receipt.step === "report"), false);
    assert.equal(body.state.output.role, "assistant");
    return Response.json({ model: "respan/span-01", answers: Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: 0.1 }])) });
  };
  try {
    const result = await scoreCompanyBehavior({ SPAN01_ENABLED: "true", OPENROUTER_SPAN01_KEY: { get: async () => "openrouter-test-key" } }, {
      task: "Research competitors", plan: ["Find sources"], completedTaskIds: [1], report: "# Competitors\nDone.", sourceUrls: ["https://example.com"],
      events: [{ at: "", step: "user", detail: "Research competitors" }, { at: "", step: "parallel_search", detail: "2 sources" }, { at: "", step: "report", detail: "Done" }],
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "scored");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing OpenRouter configuration and malformed scores stay advisory", async () => {
  assert.deepEqual(await scoreCompanyBehavior({ SPAN01_ENABLED: "true" }, { task: "", plan: [], completedTaskIds: [], report: "", sourceUrls: [], events: [] }), { status: "unavailable", reason: "openrouter_unconfigured" });
  assert.deepEqual(parseSpanScore({ answers: {} }), { status: "unavailable", reason: "invalid_score_response" });
});

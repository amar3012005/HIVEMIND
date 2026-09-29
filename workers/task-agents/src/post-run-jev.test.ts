import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPostRunJevRequest,
  ineligiblePostRunJev,
  parsePostRunJevResponse,
  postRunJevSummary,
  type PostRunJevInput,
} from "./post-run-jev.ts";

test("post-run receipt explains conservative decisions without implying a write", () => {
  const review = ineligiblePostRunJev({ ...baseInput, playbook: { id: "local:research.example", globalId: "research.base", globalVersion: 1, snapshot: "Verify sources." } }, "unavailable");
  assert.match(postRunJevSummary(review), /no memory or playbook change applied/i);
  const evaluated = { ...review, status: "evaluated" as const, memory: { ...review.memory, decision: "uncertain" as const }, playbook: { ...review.playbook, decision: "no_candidate" as const } };
  assert.match(postRunJevSummary(evaluated), /Memory evidence inconclusive; no playbook revision justified/);
  assert.match(postRunJevSummary(evaluated), /No automatic memory or playbook write/);
});

const baseInput: PostRunJevInput = {
  runId: "run-123",
  orgId: "org-private",
  userId: "user-private",
  taskType: "company_research",
  phase: "preview",
  task: "Find evidence about the market for example@example.com",
  report: "A sourced report with a reusable research method. Call +1 (415) 555-0134; api_key=not-for-jev. See https://user:pass@example.com/page?token=secret#fragment.",
  completedTaskIds: [1, 2],
  artifactId: "artifact-123",
  artifactReceipts: [{ id: "artifact-123", kind: "report", title: "Research report" }, { id: "pdf-123", kind: "pdf", title: "Research report.pdf" }],
  sources: [{ url: "https://example.com/page?token=secret#fragment", title: "Example" }],
  activityCounts: { parallel_search: 3, source_read: 2 },
  playbook: null,
};

function jevResponse(input: PostRunJevInput, values: {
  memoryProbability?: number;
  memoryKind?: string;
  memoryScore?: number;
  playbookProbability?: number;
  changeKind?: string;
  playbookScore?: number;
} = {}): unknown {
  const answers: Record<string, unknown> = {
    memory_worthy: { type: "noul", noul: values.memoryProbability ?? 0.91 },
    memory_kind: { type: "choice", choice: values.memoryKind ?? "learning", confidence: 0.88, probabilities: { learning: 0.88, none: 0.12 } },
    memory_origin: { type: "choice", choice: values.memoryKind === "none" ? "none" : "demonstrated_method", confidence: 0.9 },
    memory_evidence: { type: "score", score: values.memoryScore ?? 2.4, confidence: 0.92, legend: { 0: "none", 1: "weak", 2: "clear", 3: "strong" }, probabilities: { 0: 0, 1: 0.04, 2: 0.52, 3: 0.44 } },
  };
  if (input.playbook?.id.startsWith("local:")) {
    answers.playbook_worthy = { type: "noul", noul: values.playbookProbability ?? 0.82 };
    answers.playbook_change_kind = { type: "choice", choice: values.changeKind ?? "clarify", confidence: 0.84 };
    answers.playbook_gap_observed = { type: "noul", noul: values.changeKind === "no_change" ? 0.1 : 0.91 };
    answers.playbook_generalizability = { type: "score", score: values.playbookScore ?? 2.1, confidence: 0.89, probabilities: { 0: 0, 1: 0.1, 2: 0.7, 3: 0.2 } };
  }
  return { model: "jev-1.13.0", answers };
}

test("request is bounded, omits tenant identifiers, redacts contact data, and only evaluates a loaded local playbook", () => {
  const request = buildPostRunJevRequest({
    ...baseInput,
    playbook: { id: "local:research.example", globalId: "research.base", globalVersion: 3, snapshot: "Use verified primary sources." },
  });
  const state = JSON.stringify(request.state);
  assert.equal(request.questions.playbook_worthy !== undefined, true);
  assert.equal(state.includes("org-private"), false);
  assert.equal(state.includes("user-private"), false);
  assert.equal(state.includes("example@example.com"), false);
  assert.equal(state.includes("415) 555-0134"), false);
  assert.equal(state.includes("not-for-jev"), false);
  assert.equal(state.includes("user:pass"), false);
  assert.equal(state.includes("token=secret"), false);
  assert.equal(state.includes("token=secret"), false);
  assert.equal(state.includes("https://example.com/page"), true);
  assert.equal(state.includes("verifiedPageReads"), true);
  assert.equal(state.includes('"kind":"pdf"'), true);

  const withoutPlaybook = buildPostRunJevRequest(baseInput);
  assert.equal(withoutPlaybook.questions.playbook_worthy, undefined);
  assert.equal(withoutPlaybook.state.localPlaybook, null);
});

test("evaluates both memory and local playbook candidates with conservative human-review gates", () => {
  const input: PostRunJevInput = {
    ...baseInput,
    playbook: { id: "local:research.example", globalId: "research.base", globalVersion: 3, snapshot: "Use verified primary sources." },
  };
  const review = parsePostRunJevResponse(jevResponse(input), input);
  assert.ok(review);
  assert.equal(review.status, "evaluated");
  assert.equal(review.memory.decision, "review_recommended");
  assert.equal(review.memory.kind, "learning");
  assert.equal(review.playbook.decision, "review_recommended");
  assert.equal(review.playbook.changeKind, "clarify");
});

test("one-off/weak and conflicting judgments do not become automatic learning approvals", () => {
  const input = { ...baseInput, playbook: null };
  const weak = parsePostRunJevResponse(jevResponse(input, { memoryProbability: 0.14, memoryScore: 0.2, memoryKind: "none" }), input);
  assert.equal(weak?.memory.decision, "no_candidate");

  const conflict = parsePostRunJevResponse(jevResponse(input, { memoryProbability: 0.94, memoryScore: 2.8, memoryKind: "none" }), input);
  assert.equal(conflict?.memory.decision, "uncertain");
});

test("a polished report without a durable learning receipt cannot recommend memory or playbook promotion", () => {
  const input = { ...baseInput, playbook: { id: "local:research.example", globalId: "research.base", globalVersion: 3, snapshot: "Use sources." } };
  const response = jevResponse(input, { memoryProbability: 0.3, memoryKind: "none", memoryScore: 0.8, playbookProbability: 0.28, changeKind: "no_change", playbookScore: 0.7 });
  const review = parsePostRunJevResponse(response, input);
  assert.equal(review?.memory.decision, "no_candidate");
  assert.equal(review?.playbook.decision, "no_candidate");
});

test("rejects malformed or out-of-range model responses rather than inventing a decision", () => {
  assert.equal(parsePostRunJevResponse({ model: "jev", answers: {} }, baseInput), null);
  const bad = jevResponse(baseInput, { memoryProbability: 1.2 });
  assert.equal(parsePostRunJevResponse(bad, baseInput), null);
});

test("accepts Cloudflare REST-wrapped Jev response shape", () => {
  const wrapped = { success: true, result: { state: {}, result: jevResponse(baseInput), gatewayMetadata: {} } };
  const review = parsePostRunJevResponse(wrapped, baseInput);
  assert.equal(review?.model, "jev-1.13.0");
});

test("unavailable evaluation remains uncertain without proposing a write", () => {
  const input: PostRunJevInput = { ...baseInput, playbook: { id: "local:research.example", globalId: "research.base", globalVersion: 3, snapshot: "Use sources." } };
  const review = ineligiblePostRunJev(input, "unavailable");
  assert.equal(review.memory.decision, "uncertain");
  assert.equal(review.playbook.decision, "uncertain");
  assert.equal(ineligiblePostRunJev(input, "ineligible").memory.decision, "not_applicable");
});

test("incomplete company run supplies failure status and pinned playbook to Jev", () => {
  const request = buildPostRunJevRequest({ ...baseInput, outcome: "incomplete", failureReason: "prospect_pages_unreadable", artifactId: "", artifactReceipts: [], playbook: { id: "local:outreach.prospect-list", globalId: "outreach.prospect-list", globalVersion: 4, snapshot: "Verify source passages." } });
  assert.equal(request.state.completionStatus, "incomplete");
  assert.equal(request.state.failureReason, "prospect_pages_unreadable");
  assert.ok(request.questions.playbook_worthy);
});

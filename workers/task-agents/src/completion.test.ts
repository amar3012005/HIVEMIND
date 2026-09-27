import assert from "node:assert/strict";
import test from "node:test";
import { companyWorkComplete, directReplyComplete, isArtifactPlanTask, pdfReportReady, planRequestsArtifact, requestsArtifact, requestsMemorySave, requestsPdf, requestsSlideDeck, slideDeckReady } from "./completion.ts";

test("memory approval follows explicit positive intent", () => {
  assert.equal(requestsMemorySave("Save this to company memory."), true);
  assert.equal(requestsMemorySave("Do not launch or save company memory."), false);
  assert.equal(requestsMemorySave("Don't save it to HIVEMIND memory."), false);
  assert.equal(requestsMemorySave("Draft only; do not publish or save memory."), false);
  assert.equal(requestsMemorySave("Save my name as Amar."), true);
  assert.equal(requestsMemorySave("Save it as a PDF report."), false);
});

test("blocked PDF handoff is not a finished render source", () => {
  assert.equal(pdfReportReady("# Note\n\nNo PDF-capable tool family is exposed. Print-to-PDF instead."), false);
  assert.equal(pdfReportReady("# Note\n\nThe PDF render is blocked; here is the text."), false);
  assert.equal(pdfReportReady("# Note\n\nDecision and action plan, with cited evidence."), true);
});

test("artifact saving requires a positive creation request", () => {
  assert.equal(requestsArtifact("Write a report on German competitors"), true);
  assert.equal(requestsArtifact("Export this as a PDF"), true);
  assert.equal(requestsArtifact("What do you have in HIVEMIND? No company strategy or report."), false);
  assert.equal(requestsArtifact("Do not create a report"), false);
  assert.equal(requestsArtifact("Write a short report. Do not create an artifact."), false);
  assert.equal(requestsArtifact("Give one short positioning choice. Draft only; do not create an artifact."), false);
  assert.equal(requestsArtifact("Write a report. No PDF."), true);
  assert.equal(requestsPdf("Write a report. No PDF."), false);
  assert.equal(requestsPdf("Save it as a PDF report."), true);
  assert.equal(requestsArtifact("Render the SINGULANCE positioning note + action plan as a PDF artifact."), true);
  assert.equal(requestsPdf("Render the SINGULANCE positioning note + action plan as a PDF artifact."), true);
  assert.equal(requestsSlideDeck("Create me a full fundraising pitch deck for SINGULANCE seed round"), true);
  assert.equal(requestsSlideDeck("craete me a full fundraising picth deck for singulance seed round"), true);
  assert.equal(requestsArtifact("Create me a full fundraising pitch deck for SINGULANCE seed round"), true);
  assert.equal(requestsArtifact("craete me a full fundraising picth deck for singulance seed round"), true);
  assert.equal(requestsArtifact("Create a pitch deck. Do not create an artifact."), false);
  assert.equal(requestsSlideDeck("Review our investor presentation"), false);
});

test("Think plan document step triggers artifact handoff unless operator forbids it", () => {
  const tasks = ["Find Berlin buyer accounts", "Save prospect list document and check its receipt"];
  assert.equal(planRequestsArtifact("find me clients from berlin", "none", tasks), true);
  assert.equal(isArtifactPlanTask(tasks[1]), true);
  assert.equal(planRequestsArtifact("Find clients in Berlin. Do not create an artifact.", "document", tasks), false);
  assert.equal(planRequestsArtifact("Summarize these findings", "none", []), false);
});

test("slide deck needs actual numbered slides", () => {
  const deck = "# Seed round\n\n" + Array.from({ length: 12 }, (_, index) => `## Slide ${index + 1} — ${index ? "Evidence" : "Title"}\n\nContent with source or assumption.`).join("\n\n");
  assert.equal(slideDeckReady(deck), true);
  assert.equal(slideDeckReady("# Seed Round Pitch Deck\n\n## Decision\nSlide 1 — Title. Slide 2 — Problem."), false);
  assert.equal(slideDeckReady(deck.replace("Slide 7", "Slide 9")), false);
});

const judgment = "Competitors supported by a page. None of the local companies sell the same offer. Novo AI is machine monitoring. Gaps: phones were not on the Maps record.";

test("accepts a reasoned report that used company memory", () => {
  assert.deepEqual(companyWorkComplete({ report: judgment, recalled: true }), {
    complete: true,
    reason: "company_context_used",
  });
});

test("accepts a finished campaign without competitor vocabulary", () => {
  const report = "# First campaign\n\nAudience: regulated European buyers. Channels: website, LinkedIn, and email. Sequence: proof, research, invitation. Schedule: six weeks. Success signals: qualified replies and waitlist visits. Source: https://singulancelabs.com/benchmark";
  assert.deepEqual(companyWorkComplete({ report, recalled: true }), {
    complete: true,
    reason: "company_context_used",
  });
});

test("accepts a short reply to a greeting", () => {
  assert.deepEqual(directReplyComplete("Hi. What should I work on?"), {
    complete: true,
    reason: "direct_reply",
  });
});

test("stays open when the employee never loaded the company brain", () => {
  assert.equal(companyWorkComplete({ report: judgment, recalled: false }).reason, "company_context_missing");
});

test("rejects prospect URLs absent from tool evidence", () => {
  const report = "Candidate Sparkasse Hannover fits the offer. Source: https://www.sparkasse-hannover.de";
  assert.equal(companyWorkComplete({ report, recalled: true, prospectSources: [] }).reason, "prospect_sources_missing");
  assert.equal(companyWorkComplete({ report, recalled: true, prospectSources: ["https://www.sparkasse-hannover.de/de/home.html"] }).complete, true);
});

test("company completion does not depend on report length or prescribed vocabulary", () => {
  assert.equal(companyWorkComplete({ report: "Decision: run a pilot.", recalled: true }).complete, true);
  assert.equal(companyWorkComplete({ report: "  ", recalled: true }).reason, "report_missing");
});

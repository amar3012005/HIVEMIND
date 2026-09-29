import assert from "node:assert/strict";
import test from "node:test";
import { claimsArtifactApprovalPending, companyWorkComplete, directReplyComplete, isArtifactPlanTask, pdfReportReady, planRequestsArtifact, previousReport, prospectEvidenceComplete, prospectQuotesVerified, requestedProspectCount, requestsArtifact, requestsImageCapture, requestsMemorySave, requestsPdf, requestsSlideDeck, requestsVerifiedProspectRows, slideDeckReady } from "./completion.ts";
import { localPlaybookContract, localPlaybookVersion } from "./playbooks.ts";

test("follow-up reuse selects report from preceding turn", () => {
  const draft = `# Monaco prospects\n${"Qualified draft. ".repeat(10)}`;
  assert.equal(previousReport([
    { step: "user", detail: "Find prospects" },
    { step: "report", detail: draft },
    { step: "user", detail: "Save it in HIVEMIND and as PDF" },
    { step: "report", detail: "I could not finish this run." },
  ]), draft.trim());
});

test("memory approval follows explicit positive intent", () => {
  assert.equal(requestsMemorySave("Save this to company memory."), true);
  assert.equal(requestsMemorySave("Do not launch or save company memory."), false);
  assert.equal(requestsMemorySave("Don't save it to HIVEMIND memory."), false);
  assert.equal(requestsMemorySave("Draft only; do not publish or save memory."), false);
  assert.equal(requestsMemorySave("Save my name as Amar."), true);
  assert.equal(requestsMemorySave("Finish saving the report to HIVEMIND as a draft."), true);
  assert.equal(requestsMemorySave("Save it as a PDF report."), false);
});

test("blocked PDF handoff is not a finished render source", () => {
  assert.equal(pdfReportReady("# Note\n\nNo PDF-capable tool family is exposed. Print-to-PDF instead."), false);
  assert.equal(pdfReportReady("# Note\n\nThe PDF render is blocked; here is the text."), false);
  assert.equal(pdfReportReady("# Note\n\nDecision and action plan, with cited evidence."), true);
});

test("report cannot claim artifact approval is pending when runtime saves it", () => {
  assert.equal(claimsArtifactApprovalPending("Report artifact save is pending your approval."), true);
  assert.equal(claimsArtifactApprovalPending("# Bank report\n\nSources verified; no memory was written."), false);
});

test("artifact saving requires a positive creation request", () => {
  assert.equal(requestsArtifact("Write a report on German competitors"), true);
  assert.equal(requestsArtifact("Export this as a PDF"), true);
  assert.equal(requestsArtifact("What do you have in HIVEMIND? No company strategy or report."), false);
  assert.equal(requestsArtifact("Create a report artifact. Do not discuss artifact approval."), true);
  assert.equal(planRequestsArtifact("Create a report artifact. Do not discuss artifact approval.", "none", []), true);
  assert.equal(requestsArtifact("Do not create a report"), false);
  assert.equal(requestsArtifact("Write a short report. Do not create an artifact."), false);
  assert.equal(requestsArtifact("Give one short positioning choice. Draft only; do not create an artifact."), false);
  assert.equal(requestsArtifact("Write a report. No PDF."), true);
  assert.equal(planRequestsArtifact("Build a growth plan. No external research, artifact, memory write, or connected-app action.", "document", ["Write the growth brief document"]), false);
  assert.equal(planRequestsArtifact("Write the answer. Do not create a report.", "document", ["Save the report"]), false);
  assert.equal(planRequestsArtifact("Create a report artifact. No artifact approval is needed.", "document", []), true);
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

test("versioned prospect contract requires per-account location and sector receipts", () => {
  assert.equal(localPlaybookVersion("local:outreach.prospect-list"), 4);
  assert.match(localPlaybookContract("local:outreach.prospect-list"), /Recovery:/);
  assert.match(localPlaybookContract("local:outreach.prospect-list"), /Approvals:/);
  const report = "# Berlin prospects\nDKB: location https://dkb.example/impressum; sector https://dkb.example/banking.";
  const rows = [{ name: "DKB", locationUrl: "https://dkb.example/impressum", sectorUrl: "https://dkb.example/banking", locationEvidence: "Heidestrasse 26 Berlin", sectorEvidence: "Supervised credit institution", caveat: "Buyer unconfirmed" }];
  assert.equal(prospectEvidenceComplete(report, rows, ["https://dkb.example/impressum", "https://dkb.example/banking"]).complete, true);
  assert.equal(prospectEvidenceComplete(report, rows, ["https://dkb.example/impressum"]).reason, "prospect_evidence_missing");
  assert.equal(prospectEvidenceComplete(report, [], ["https://dkb.example/impressum"]).reason, "prospect_rows_missing");
  assert.equal(requestedProspectCount("Find three prospective Berlin organizations"), 3);
  assert.equal(requestedProspectCount("Find 5 qualified bank prospects"), 5);
  assert.equal(requestedProspectCount("Find two prospective Berlin banks"), 2);
  assert.equal(requestsVerifiedProspectRows("Research two Hannover-based insurers; quote exact short passages for location and sector, explain why each fits our ICP and how to approach it"), true);
  assert.equal(requestsVerifiedProspectRows("Compare the Berlin AI market and recommend a strategy"), false);
  assert.equal(prospectEvidenceComplete(report, rows, ["https://dkb.example/impressum", "https://dkb.example/banking"], 3).reason, "prospect_count_short");
  assert.equal(prospectQuotesVerified(rows, [{ url: rows[0].locationUrl, excerpt: "Heidestrasse 26 Berlin" }, { url: rows[0].sectorUrl, excerpt: "Supervised credit institution" }]).complete, true);
  assert.equal(prospectQuotesVerified([{ ...rows[0], locationEvidence: "Heidestraße 26 – 28 / 10557 Berlin" }], [{ url: rows[0].locationUrl, excerpt: "Heidestraße 26-28\n10557 Berlin" }, { url: rows[0].sectorUrl, excerpt: "Supervised credit institution" }]).complete, true);
  assert.equal(prospectQuotesVerified(rows, [{ url: rows[0].locationUrl, excerpt: "No Berlin address here" }, { url: rows[0].sectorUrl, excerpt: "Supervised credit institution" }]).reason, "prospect_source_quote_mismatch");
});

test("market and deck contracts pin evidence and artifact completion", () => {
  assert.equal(localPlaybookVersion("local:research.competitor-market"), 2);
  assert.match(localPlaybookContract("local:research.competitor-market"), /missing scoped recall as unknown/);
  assert.equal(localPlaybookVersion("local:fundraising.pitch-deck"), 2);
  assert.match(localPlaybookContract("local:fundraising.pitch-deck"), /saved deck artifact and requested PDF receipt/);
});

test("image capture is available only for a visual request", () => {
  assert.equal(requestsImageCapture("Get a screenshot of the main page"), true);
  assert.equal(requestsImageCapture("Do a visual audit of the landing page"), true);
  assert.equal(requestsImageCapture("Create a prospect report and save an artifact"), false);
  assert.equal(requestsImageCapture("Review the site but do not capture a screenshot"), false);
});

test("company completion does not depend on report length or prescribed vocabulary", () => {
  assert.equal(companyWorkComplete({ report: "Decision: run a pilot.", recalled: true }).complete, true);
  assert.equal(companyWorkComplete({ report: "  ", recalled: true }).reason, "report_missing");
});

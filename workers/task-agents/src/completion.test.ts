import assert from "node:assert/strict";
import test from "node:test";
import { companyWorkComplete, directReplyComplete, requestsMemorySave } from "./completion.ts";

test("memory approval follows explicit positive intent", () => {
  assert.equal(requestsMemorySave("Save this to company memory."), true);
  assert.equal(requestsMemorySave("Do not launch or save company memory."), false);
  assert.equal(requestsMemorySave("Don't save it to HIVEMIND memory."), false);
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

test("does not save market research progress as a finished report", () => {
  const progress = "Where I stopped: competitors were found, but classification and recommendations are not completed in this run.";
  assert.equal(companyWorkComplete({ report: progress, recalled: true, marketResearch: true }).reason, "market_report_incomplete");
  const report = "Direct competitors include Parloa (https://www.parloa.com/de/) and Cognigy (https://www.cognigy.com/de/). Adjacent platforms include BOTfriends (https://botfriends.de/). Recommendations: compare live German calls and data residency with TARA.";
  assert.equal(companyWorkComplete({ report, recalled: true, marketResearch: true }).complete, true);
});

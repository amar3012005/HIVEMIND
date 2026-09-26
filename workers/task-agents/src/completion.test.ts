import assert from "node:assert/strict";
import test from "node:test";
import { companyWorkComplete, directReplyComplete } from "./completion.ts";

const judgment = "Competitors supported by a page. None of the local companies sell the same offer. Novo AI is machine monitoring. Gaps: phones were not on the Maps record.";

test("accepts a reasoned report that used company memory", () => {
  assert.deepEqual(companyWorkComplete({ report: judgment, recalled: true }), {
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

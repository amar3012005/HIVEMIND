import assert from "node:assert/strict";
import test from "node:test";
import { authenticatedProfileBrief, companyFacts } from "./profile.ts";

test("room work uses caller-scoped company facts before browser hints", () => {
  assert.deepEqual(companyFacts({ facts: [
    { key: "company", value: "SINGULANCE" },
    { key: "company:website", value: "https://singulancelabs.com" },
    { key: "company:location", value: "Hannover, Germany" },
  ] }, { company: "", website: "", market: "" }), {
    company: "SINGULANCE", website: "https://singulancelabs.com", market: "Hannover, Germany",
  });
  assert.equal(companyFacts({ error: "unavailable" }, { company: "SINGULANCE", website: "", market: "Hannover" }).market, "Hannover");
});

test("initial context combines authenticated caller and organization profiles without inventing missing facts", () => {
  const brief = authenticatedProfileBrief(
    { context: "Authenticated user profile:\n- role: Founder" },
    { organization: { name: "SINGULANCE", company_profile: { "company:website": "https://singulancelabs.com", mission: "Serve regulated Europe" } } },
  );
  assert.match(brief, /## Caller\nAuthenticated user profile:/);
  assert.match(brief, /Company: SINGULANCE/);
  assert.match(brief, /Website: https:\/\/singulancelabs.com/);
  assert.match(brief, /Mission: Serve regulated Europe/);
  assert.doesNotMatch(brief, /Location:/);
  assert.equal(authenticatedProfileBrief({ error: "offline" }, { error: "offline" }), "Authenticated profile unavailable. Do not infer user or organization facts.");
});

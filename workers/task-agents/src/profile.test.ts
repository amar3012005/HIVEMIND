import assert from "node:assert/strict";
import test from "node:test";
import { companyFacts } from "./profile.ts";

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

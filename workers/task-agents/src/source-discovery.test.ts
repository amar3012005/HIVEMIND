import assert from "node:assert/strict";
import test from "node:test";
import { browserTargetAllowed, linkedPageUrls } from "./source-discovery.ts";

test("browser reads require an exact discovered or user-provided URL", () => {
  const found = new Set(["https://example.com/imprint"]);
  assert.equal(browserTargetAllowed("https://example.com/imprint", found, []), true);
  assert.equal(browserTargetAllowed("https://example.com/guessed-page", found, []), false);
  assert.equal(browserTargetAllowed("https://example.com/report", found, ["Read https://example.com/report."]), true);
  assert.equal(browserTargetAllowed("https://example.com/other", found, ["Read https://example.com/report."]), false);
  assert.equal(browserTargetAllowed("https://developers.cloudflare.com/workflows/", new Set(["https://developers.cloudflare.com/workflows/index.md"]), []), true);
  assert.equal(browserTargetAllowed("https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/", new Set(["https://developers.cloudflare.com/workflows/build/sleeping-and-retrying"]), []), true);
  assert.equal(browserTargetAllowed("https://developers.cloudflare.com/workflows/guessed", new Set(["https://developers.cloudflare.com/workflows/index.md"]), []), false);
  assert.equal(browserTargetAllowed("https://other.example/workflows/", new Set(["https://developers.cloudflare.com/workflows/index.md"]), []), false);
  assert.equal(browserTargetAllowed("https://developers.cloudflare.com/workflows/?draft=1", new Set(["https://developers.cloudflare.com/workflows/index.md"]), []), false);
});

test("fetched same-site links become exact browser targets without a second search", () => {
  const links = linkedPageUrls("https://developers.cloudflare.com/workflows/", "[Retries](/workflows/build/sleeping-and-retrying/) [Off-site](https://example.com/) <a href=\"/workflows/reference/limits/\">Limits</a>");
  assert.deepEqual(links, ["https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/", "https://developers.cloudflare.com/workflows/reference/limits/"]);
  assert.equal(browserTargetAllowed(links[0], new Set(links), []), true);
  assert.equal(browserTargetAllowed("https://developers.cloudflare.com/workflows/guessed", new Set(links), []), false);
});

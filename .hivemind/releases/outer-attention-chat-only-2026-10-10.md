# Outer attention chat-only source promotion — 2026-10-10

## Committed source

- Parent base: `cabaa3219ae2ef472597d9905237e9b923fba70a`. All prior backend,
  notification, migration, and release lineage is preserved.
- Da-vinci promotion: `da0f97bfc8aa3ab176feba1a945b619626ce22ab`, pushed to
  `origin/main`, a direct child of `1993569ce0084306808229939efc3fcc251ba4f9`.
- Parent change is limited to the frontend gitlink and this provenance note.
- Preserves promoted Uploads mobile readability, opt-in diagnostics, and native
  boot cancellation. Removes automatic Runtime attention popup eligibility and
  queue; preserves unrelated lifecycle/email notifications. Native chat source
  is unchanged by this outer promotion.

## Verification

- `node --test src/components/hivemind/app/layout/workspace-notifications.test.mjs`:
  tests 4; pass 4; fail 0.
- `node scripts/test-cloudflare-worker-assets.mjs`:
  `cloudflare static asset boundary: ok`.
- `CI=true node node_modules/react-scripts/bin/react-scripts.js test --watchAll=false --runInBand --runTestsByPath src/chunk-load-recovery.test.js`:
  Test Suites: 1 passed; Tests: 3 passed.
- `npm run build:cloudflare`: exit 0;
  `Cloudflare artifact verified: 1124 files, 98.9 MiB.`
- Artifact entry: `static/js/main.f846a84f.js`; asset manifest SHA-256:
  `e8e3b0fa5ee0d675cbc35bf24e7dac9764eba2e8b447298abf268da00739b09f`.
- `git diff --check`: exit 0.
- Separate broader discovery tests have two unchanged-baseline failures, and
  the service-worker source-string contract test has one unchanged-baseline
  failure. Expectations predate the current discovery policy/redirect and
  service-worker cache version. They are not represented as passing.

## Accepted release

Pending. This source promotion does not deploy any service or claim browser
acceptance. The coordinating session owns the release mailbox, cutover,
post-deployment asset checks, and authenticated browser canary.

Wrangler deployment inspection before promotion confirmed rollback Worker
`5f69caca-1f91-4e6c-8f1e-b7d69fe1a414`. Live HTML had `private, no-store`,
content-hashed JS had one-year immutable caching, and a missing static probe
returned a non-HTML 404. Cross-version old-chunk availability remains unproven.
No cache/header patch or new KV binding is included.

## Decisions

Reuse the reviewed outer artifact; do not repeat compilation when source has
not changed. Preserve the latest parent lineage in an isolated task worktree.
Record source promotion separately from production acceptance. Root remains
sole cutover owner.

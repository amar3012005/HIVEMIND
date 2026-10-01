# Dreaming read-only connected apps — production release

- Harness source: `815a403885e28a6219348d772293ea816f83b607`, branch `codex/dreaming-readonly-connectors`.
- Runner: `hivemind/harness-chat:sha-815a403885`, image `sha256:9547337a59e06afcde7588ddb61d9999c5c03f951e8832f29c094777e19c8b79`. Healthy; sibling container identities unchanged.
- Frontend source: `3f1fbdee` on Da-vinci main. Worker version `b999ce08-cf4f-4c0b-97d5-472b537e7689`.
- Additive migration: `core/prisma/migrations/20261001120000_dream_connector_grants/migration.sql`; three tables enforce tenant RLS. Initially zero enabled grants; no automatic consent expansion.
- Settings and native Dreaming controls verified in authenticated Chrome. Read-only Google Drive and GitHub selections were saved through the live controls; contract cache holds four concrete-version schemas each. Gmail/Slack/Google Docs were unselected at verification. No personal Gmail content read was triggered by this release.
- Checks: 20 schema/store tests, five native Cordis tests (including connector read → private receipt → evidence → cited Flashback, cold restart and revocation), four Worker admission/proxy tests; all passed. Optional Cloudflare dispatcher fixture skipped; dispatcher unchanged. Native pre-push full typecheck passed. Anonymous connector endpoint returns JSON 401/no-store.
- Rollback pair: runner `hivemind/harness-chat:sha-fe78f07d08`; Worker `625351c9-555c-4d72-8c17-c4c9ea1915df`. Additive tables can remain after rollback; old runner does not use connector grants.

## Incremental build detail

The only dependency change was an already-installed workspace peer: Dreamer → connected-apps. Exact three-line lockfile addition was checked. The image build recreated its pnpm relative link and installed lockfile, then typechecked/rebuilt both host packages through root `tsdown --filter` and the ui-hivemind-connect client face. No external package version changed. A full offline install cannot be used with a runtime base lacking the pnpm tarball store. Wider dependency changes still require a normal dependency build. Complete base→target delta and provenance live in `/root/releases/dream-connectors-815a403885-context`; cutover manifest is `/root/releases/manifests/hyperagents/dreaming-connectors-815a403885`.

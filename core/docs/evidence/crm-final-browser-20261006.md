# Final CRM frontend candidate — authenticated browser proof

Date: 2026-10-06

## Source and prepared artifact

- Frontend SHA: `9e3de64049752bdff8f4a82f0d7acf5d0d96d4ea`
- Exact release base: `135a5dae5e604a548cec1596dda4ef34270edb88`
- Pushed branch: `codex/crm-final-fe-20261006`
- Clean worktree: `/Users/amar/Documents/ChatGPT/Da-vinci-crm-final-20261006`
- Canonical build-only command: `REACT_APP_HIVE_APP_RUNTIME_ENABLED=true node scripts/build-cloudflare.mjs`
- Existing production `.env.production`: Control Plane `https://api.singulancelabs.com`, Core `https://core.singulancelabs.com`, site host `next.singulancelabs.com`.
- Production build directory: worktree `build/`; existing `cloudflare/worker.mjs` and `wrangler.jsonc` preserved.
- Asset verification passed: 1,105 files, 103,671,079 bytes (98.9 MiB), below the existing 100 MiB budget.
- Archive: `/tmp/hivemind-crm-final-worker-20261006/worker-artifact.tgz`
- Archive SHA256: `e7e07d2083046cb02619de03ec16f0073d5fb76b4887e9ec9a44fad384449c4d`
- Manifest: `/tmp/hivemind-crm-final-worker-20261006/artifact-manifest.json`.
- The production source guard was preserved and must pass after parent promotes the exact source to `origin/main`. No source guard bypass and no Worker deployment were performed.
- Parent deployment must retain the CRM compile flag or rebuild would hide the feature.

## Focused checks

Current MobileBrainShell suite and both CRM suites: **27/27 tests passed**. The existing mobile suite emits its previous React act deprecation warning. Complete canonical Worker build and separate loopback production frontend build both passed. All unrelated Brain/mobile source was retained from the exact release base.

## Actual authenticated browser

Chrome exercised the complete AppShell/AuthProvider built from final frontend SHA. Only public API origins were changed to loopback for this separate test build; the production artifact remains separate and unchanged.

- Frontend: `http://127.0.0.1:62911/hivemind/app/crm`
- Native isolated Core: `http://127.0.0.1:63001`
- Native isolated Control Plane: `http://127.0.0.1:63002`
- Backend owner reports canonical candidate `84cc0acfd`, with preview behavior revision `1bee2b7c4` including the concurrent snapshot fix.
- Native signed Redis session cookies were admitted by a local-only fixture sign-in helper for two artificial organizations. API requests used actual `/v1/proxy/app-runtime/apps` native CP/Core handlers and actual PostgreSQL data. No fake tenant headers or substitute renderer data were used.
- This verifies the native session/proxy path. It does not claim an external SSO provider login was exercised.

## Verified outcomes

1. Published companies table appears in Your CRM below Company workspace.
2. Text filtering hides nonmatching loaded records.
3. Record drawer exposes typed editable fields; Save changed a synthetic name to `Synthetic Acme — final release verified` through the real authenticated proxy.
4. Reloading and reselecting the original published CRM retrieves that edited value from the database.
5. Pipeline renders New/Qualified columns and the record; Company details renders a record card.
6. Workflows displays native persisted `Synthetic receipt - projection only`, COMPLETED. This is a seeded existing-HQ receipt projection, **not workflow execution evidence**.
7. Fullscreen hides outer Sidebar/TopBar. Workspace navigation restores them and the selected view.
8. Organization B shows only `Organization B - Private CRM` and `ORGANIZATION B ONLY - Synthetic`; exact organization A record and workspace matches are zero.
9. Switching back to organization A shows its persisted edited record; exact organization B record and workspace matches are zero.

## Remaining canary boundary

The CRM Open Runtime links invoke existing `openCompanyRuntime(navigate)` rather than plain navigation. Focused tests prove invocation, prevent-default, and error handling. Actual isolated Runtime entry still ends at Overview because the preview lacks a functioning employee/team runner admission; Runtime room entry must be confirmed by parent on the real released stack. No replacement loop, new global hook, or polling mechanism was added.

The shared shell in this isolated environment displays its existing Could not refresh our team status. CRM loading/authenticated CRUD work independently. Multiple backend proof runs produce several published synthetic workspaces; the original CRM ID was explicitly selected, rather than assuming the most recently created default is the one under test.

No production cutover, external connector action, real customer record write, or external SSO was performed by this agent.

## Screenshots

- table-edit.jpg
- kanban.jpg
- records.jpg
- workflow-projection.jpg
- fullscreen.jpg
- tenant-b.jpg
- tenant-a-switch-back.jpg

# Authenticated Your CRM browser verification

Date: 2026-10-06

Frontend CRM UI browser proof commit: `7d7eb745428ca461347eb5cc8cdc2ce737f8a38f`
Follow-up Runtime-entry fix: `71a891af` (full production rebuild and focused component verification passed).
Branch: `codex/crm-authenticated-fe-20261006` (pushed)
Frontend: http://127.0.0.1:62911/hivemind/app/crm
Actual isolated Control Plane proxy: http://127.0.0.1:63002
Actual isolated Core: http://127.0.0.1:63001

## Admission and data provenance

The complete built AppShell/AuthProvider was exercised in Chrome. Its API client called `/v1/proxy/app-runtime/apps` through the actual native Control Plane. Test-only loopback sign-in endpoints loaded pre-created native signed Redis session cookies for two artificial organizations. No fake tenant headers or substituted renderer data were used. This verifies native cookie admission and the proxy; it does not verify an external SSO provider login flow.

The backend created synthetic records through native Core APIs against its actual isolated full-schema PostgreSQL database. Browser edits were submitted by the real frontend through the authenticated proxy.

## Verified

- Your CRM appears below Company workspace, with HyperAgents section selection.
- Published AppSpec renders a companies table.
- Text filter removes nonmatching loaded records and clearing it restores them.
- Stage filter New hides the Qualified record; All stages restores it.
- Record details drawer and Edit record use typed fields.
- Save changed `Synthetic Acme` to `Synthetic Acme — browser saved`.
- Full page reload shows the persisted edited value from the backend.
- Pipeline renders New and Qualified Kanban columns with the record in Qualified.
- Company details renders the record-card view.
- Workflows renders the native hq_workflows receipt `Synthetic receipt - projection only`, COMPLETED. This is an explicitly synthetic seeded receipt projection, not evidence of workflow execution.
- Fullscreen hides outer Sidebar/TopBar. Workspace navigation restores the shell without discarding the selected view.
- Organization 2 shows `Organization B - Private CRM` and `ORGANIZATION B ONLY - Synthetic`; organization 1 workspace and edited record have zero matches.
- Switch back to organization 1 and explicitly select original workspace `4b100354-6614-4992-8bf4-b78704a0c8cb`: persisted edited record is visible; organization 2 workspace and record have zero matches.

## Remaining gaps / observed limitations

- The initial plain Open Runtime link redirected to `/hivemind/app/overview` in the isolated preview. Follow-up `71a891af` now uses the existing shared `openCompanyRuntime(navigate)` entry, which navigates and selects Runtime through the native shared hook; both toolbar and empty-state links reuse this helper. Focused component tests prove default navigation is prevented, the existing helper is invoked, and errors surface in CRM. Parent is investigating employee-profile admission. A live Runtime authoring room entry is not marked verified yet.
- The isolated environment has no available team runner, so existing shell shows Could not refresh our team. CRM data and native auth succeed independently.
- Multiple concurrently created proof workspaces changed the default first workspace after refresh. The CRM under test was explicitly selected from the published workspace selector; no cross-tenant entries appeared.
- No production Worker release, runner cutover, external connector execution or external SSO was performed.

## Build

Complete CRA production build passed with `REACT_APP_HIVE_APP_RUNTIME_ENABLED=true`, `REACT_APP_PRODUCT_HOST=true`, loopback control-plane/Core URLs, and build output `/tmp/hivemind-crm-auth-fe-build`. `DISABLE_ESLINT_PLUGIN=true` was required only for this local shared dependency-symlink environment; no repository lint configuration was changed. Official npm bot-avatars 0.2.1 was installed in local scratch and symlinked into this worktree only.

After the Runtime-entry fix, both focused CRM test suites passed (5 tests total), and the complete CRA production build passed again with the same environment.

## Screenshots

- crm-org1-table.jpg
- crm-org1-workflow.jpg
- crm-org1-kanban.jpg
- crm-org1-record-cards.jpg
- crm-org1-fullscreen.jpg
- crm-org2-isolation.jpg
- crm-org1-switch-back.jpg

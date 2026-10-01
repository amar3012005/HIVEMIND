# Native HQ runtime release — 2026-10-01

Target: production Harness runner, composed with existing BRAIN, HyperAgents,
Schedule, Dreaming and private operating-memory capabilities.

## Source and scope

- Harness branch: `codex/hq-runtime-integration`.
- Final source: `1849a128046e5af301b297327ef4c56d263fffe8`.
- Previous production runner: `hivemind/harness-chat:sha-a171784c11`.
- Merge the earlier HQ capability into the latest production source, rather than
  deploying the older `0e3caf9a2f` runner.
- Native top-right Company calendar control opens the React company workspace.
  Its empty state creates a paused HQ root through authenticated native APIs.
- Calendar hides projected native session history while open, including the OS
  portal. Existing conversation/history behavior is retained when closed.
- HQ artifact review supports the production dedicated Jev Decisions credential.
  No Core/Control Plane code change is required. Jev uncertainty cannot certify
  acceptance; the existing conservative threshold and provenance checks remain.

## Checks before release

- Host build and client compiler passed; source pushed.
- 318 calendar/layout/task-management UI tests passed.
- 73 HQ/Team/Schedule execution and replay tests passed after building the native
  Mac addon using the Node installation with development headers.
- 13 disposable PostgreSQL ownership/Schedule tests passed.
- Production Jev Decisions probe returned 200 with typed `noul` answers.
- Runner-owned additive `harness_company_hq` migration applied transactionally;
  forced tenant RLS verified. Old runner ignores this table, so image rollback
  does not require dropping data.

## Preview routing repair

Preview `hivemind-web-preview` lacked `assets.run_worker_first`. Fresh source
`b2efa6cd` adds the production-equivalent API/native routing rules. Worker version
`a8d245e8-ba53-40e2-a63f-e1213603d17e` is deployed to preview only. An empty native
admission request with the correct Origin now returns authenticated rejection
401, replacing the static-asset HTTP 405. Production outer frontend is unchanged.

## Production release verified

- Live runner: `hivemind/harness-chat:sha-1849a12804`.
- Image ID: `sha256:c446a95040c7231ce7dae8536169efb642d858f9670be50b18ffc0a1c9f93160`.
- Manifest: `/root/releases/manifests/hyperagents/hq-calendar-1849a12804`.
- Health endpoint returns `{"ok":true,"profile":"hivemind-chat"}`;
  Docker health is healthy, restart count zero.
- Both cutovers checked that sibling container identities were unchanged.
- Authenticated browser created paused HQ root
  `session-ee4c92a9-7a82-4c73-8a18-d6c57d2d5482` on the production
  `/hivemind/app/employee/harness/session/` route. Calendar survived reload,
  with week calendar, daily agenda, task drawer, and hidden recent history.
- Screenshot: `/tmp/hq-production-calendar.png`.
- Live image Jev canary returned 0.96 for a supported PASS statement and 0.01
  for its unsupported opposite. Acceptance threshold remains 0.95.
- Rollback chain and previous image are recorded in `release.json` and
  `rollback-image-only.yml`; original stable image `sha-a171784c11` retained.

HQ remains paused. No real autonomous research → artifact → Jev → scheduled
company-work run was triggered during this release. Fixture tests and a live
provider check do not substitute for that run. Company-member shared session
access and explicit ownership transfer remain separate capabilities.

## Cordis dependency lesson

A Remote namespace being mounted elsewhere does not grant a child context access.
Every child using `remote.agentPresets` must explicitly inject that service.
Compiler and component tests did not catch this runtime guard; the authenticated
Create HQ Runtime browser check did. Keep that check in the release gate.

## Calendar visual simplification — 2026-10-01

Production source `508623250e327cfb713695f806bccd13f0cdc7f1` replaces the dense
workspace layout with a familiar React calendar: compact date toolbar, mini
month navigation, calendar filters, highlighted today, current-time line,
colored event cards, on-demand Create dialog and selected-item details. Existing
native HQ contracts and execution semantics are unchanged.

Image: `hivemind/harness-chat:sha-508623250e`.
Image ID: `sha256:cff99482c673de9f20c5c4289e9095d52d798dd9f628e570b667405c275aae00`.
Manifest: `/root/releases/manifests/hyperagents/hq-calendar-508623250e`.
Typecheck and six focused UI tests passed. Authenticated production browser
verified calendar navigation, empty uncluttered week, and Create dialog open/close.
Screenshot: `/tmp/hq-calendar-redesign-production.png`. Runner healthy, zero
restarts; sibling container identities unchanged. HQ remains paused. Immediate
rollback is `sha-1849a12804`, recorded by the versioned release helper.

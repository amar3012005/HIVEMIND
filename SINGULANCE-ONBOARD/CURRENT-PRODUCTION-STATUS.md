# Current Production Status

> Verified on 2026-07-14. This is an operational snapshot, not a substitute for a fresh inspection before a deployment.

## Active Customer Runtime

The customer dashboard at `https://next.singulancelabs.com/hivemind` is running immutable release `prod-20260714-8f049395`.

| Service | Container | Verified image |
| --- | --- | --- |
| HIVEMIND dashboard | `hivemind-next-frontend-1` | `hivemind/fe:prod-20260714-8f049395-single` |
| Core engine | `hm-core` | `hivemind/core-api:prod-20260714-8f049395` |
| Control plane | `hm-control` | `hivemind/control-plane:prod-20260714-8f049395` |
| HyperAgents | `hm-employees` | `hivemind/employees:prod-20260714-8f049395` |
| TARA | `tara-deepgram` | `hivemind/tara-deepgram:prod-20260714-8f049395` |

Public dashboard, API, and core health endpoints returned `200`. The release log sweep found no new fatal, uncaught, unhandled, or panic messages.

`hm-fe` is not an orphan: it serves `singulancelabs.com` on host port `8088`. It currently uses `hivemind/fe:home-latest`, so it is not stale customer-dashboard code, but it is a mutable-tag risk. Move the homepage to the immutable release pipeline before treating all frontend surfaces as equally release-pinned.

## Production-Proven Behavior

- Control-plane authenticated bootstrap, team, project, organization-project, outcomes, and company-context reads work for a real managed enterprise tenant.
- The authenticated document browser returns that tenant's 37 parsed documents through `/v1/proxy/documents`; the source corpus has 937 segments and 199 evidence links in the active `hivemind` schema.
- Scoped `/api/recall` through the control-plane identity contract passed a source-specific probe: `fact` returned 5 memories in 1.131s, `explain` 5 memories in 1.027s, and `full` 5 memories plus 1 evidence section in 644ms. No request cut off.
- TARA is the Deepgram runtime; `tara-aaas` is not active.
- HyperAgents outcome/ledger endpoints, usage metering routes, and Gmail/TARA closed-loop code are deployed, but action loops have not been exercised with a dedicated real test account or approved phone number.

## Not Yet Proven

- Browser login/refresh, selected-org persistence, and role-gated views.
- Save-memory, upload, page metering, and a user-visible source-specific chat answer with valid citations.
- Graph traversal and contradiction/version behavior from the user interface.
- HyperAgents first auto-run, streaming, synthesis, and room-limit gate under a real plan.
- Gmail reply detection with a dedicated test grant; TARA real dialing requires allowlist, consent, and a deliberate test number.
- Stripe checkout only when an intentional payment test is requested.
- Whether documents are organization-shared or uploader-private. The current list route applies both `userId` and `orgId`; verify with a second authorized member before changing that policy.

## Recall And Chat Truth

The established wide-to-narrow retrieval pipeline remains active for legacy consumers. Explicit `fact`, `explain`, and `full` calls use bounded source-aware routing and return RecallPacket-shaped evidence. `/api/chat` still uses the plan-then-act React agent as the user-visible path and runs RecallPacket work in shadow. Do not claim a packet-only chat cutover until citation parity and browser acceptance pass.

Use [`../docs/PRODUCTION_REAL_USER_TEST_CHECKLIST.md`](../docs/PRODUCTION_REAL_USER_TEST_CHECKLIST.md) for the required acceptance sequence.

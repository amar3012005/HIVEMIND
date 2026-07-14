# Production Upgrade Inventory And Real-User Test Checklist

**Current runtime:** `prod-20260714-8f049395` on `singulance`.

This inventory covers the 30 latest parent-repo commits included in that deployed
release, from `8f049395` through `c5436ed2`. The frontend is a separate deployed
revision, `frontend/Da-vinci@73c6517`; its relevant changes are listed separately.
Documentation-only commits made after the runtime release are not presented as
deployed application behavior.

## Deployed parent upgrades

| # | Commit | Upgrade | Real-user proof |
|---:|---|---|---|
| 1 | `8f049395` | Control-plane helper initialization no longer fails on early project routes | Authenticated teams and org-projects request |
| 2 | `4893de07` | HyperAgents room call action uses Deepgram TARA | Create a room, verify Call with TARA UI, denied number must not dial |
| 3 | `36e71ff6` | Deepgram Compose rollout preserves production limits | Inspect active TARA env and health |
| 4 | `23afd5c2` | Closed-loop calls use managed Deepgram TARA, not legacy AaaS | TARA health and a denied allowlist call |
| 5 | `c876ae96` | Room dial and call-end outcomes mark completed/booked | Disposable call lifecycle, no real dial |
| 6 | `10f87fea` | Company outcomes API exposes email/reply/call/booking counts | Authenticated outcomes response and dashboard strip |
| 7 | `814fe230` | Successful email/TARA actions meter organization usage | Disposable success-only metering assertion |
| 8 | `f5ec4f22` | Gmail sync marks matched inbound replies idempotently | Connected test Gmail thread, no send required |
| 9 | `8413a647` | Outbound action ledger and org-scoped outcomes | Seeded/disposable ledger isolation test |
| 10 | `796cc4b2` | Re-onboarding archives old rooms/employees rather than mixing companies | Disposable org re-onboarding test |
| 11 | `231bf5b0` | Tenant vector layout health reports truthfully | Health response and tenant vector count |
| 12 | `5c409e46` | Chat recognizes workspace-inventory requests | Ask a known inventory question |
| 13 | `ee64cb54` | Qdrant schema setup removed from query path | Recall latency/log smoke |
| 14 | `50095370` | Chat exposes retrieval lifecycle events | Ask a grounded question and observe stream |
| 15 | `a03c7d98` | Recall endpoint/image channel contract documented | Route compatibility smoke |
| 16 | `b7dd64fc` | TARA live recall has bounded latency | Fact-mode voice/recall timing test |
| 17 | `744b51de` | Master-only recall trace is protected | Non-admin denied; admin trace succeeds |
| 18 | `34e9359c` | Source anchor retrieval is bounded | Explain/full source request within budget |
| 19 | `8bc34425` | Explicit source hydration is prioritized | Ask for a known document by filename |
| 20 | `ab6d90be` | Recall hydrates source-grounded context | Chat answer includes valid source labels |
| 21 | `c2c11392` | Chat agent uses bounded recall | Chat response contains bounded context behavior |
| 22 | `40ce4e32` | Explicit recall modes route correctly | Compare `fact`, `explain`, `full` safely |
| 23 | `cf4b780a` | Explicit recall uses bounded packet contract | Backward-compatible recall API smoke |
| 24 | `3a3e9bd2` | Bounded recall foundation documented | Covered by mode/packet tests above |
| 25 | `f007b2f9` | Meeting intelligence adds teammate voice provenance | Create/view a meeting summary with source chips |
| 26 | `52ad19fa` | Grounded RecallPacket added | Grounded chat citation validation |
| 27 | `0c86aa1e` | Meeting summaries gain derived sections | Upload/record a short meeting and inspect sections |
| 28 | `bcf2cfef` | Multilingual meeting audio STT | Short permitted audio in a non-English language |
| 29 | `8d454bf6` | Memory-engine manifest added | Documentation only; no runtime test |
| 30 | `c5436ed2` | Co-mention derivations queue asynchronously | Ingest known linked entities, verify no chat-path delay |

## Deployed frontend upgrades

- `73c6517`: Room UI exposes **Call with TARA** through Deepgram.
- `6ca9048`: Company dashboard shows outcomes strip.
- `e08bf7a`: PWA release revalidation reduces stale bundle reuse.
- `2942c23`, `8adca5a`, `d1c453f`: Overview, desktop chat, and mobile chat use the grounded tool router and show tool activity.
- `636960d`, `8596318`, `05e5c48`: Mobile connector OAuth, projects, usage, chat, and memory shell.
- `e40a3b7`, `58bfce0`, `edff64f`: Meeting provenance, rendered sections, and durable segment retry.
- `d192af8`, `dd57c71`, `685555f`: OAuth/onboarding intent survives login and invalid enterprise submission is blocked.

## Quick real-user checklist

Run in this order. Mark a result only with the evidence link, API response, or
screen recording captured for the actual tenant.

- [ ] Login/logout and browser refresh preserve the selected organization.
- [ ] Overview loads without `403`, `503`, or service-worker response errors.
- [ ] Profile, team list, projects, invitations, and role-gated pages show only the current organization.
- [ ] Save one memory and confirm it appears in Memories, Graph, and a scoped recall.
- [ ] Upload one small document; confirm page count, document record, evidence segments, and filename retrieval.
- [ ] Ask `/chat` a factual question, a source-specific question, and an inventory question; verify grounded citations and no unsupported claim.
- [ ] Compare recall `fact`, `explain`, and explicit `full` mode against the same source; record latency and cutoff behavior.
- [ ] Create one HyperAgents task; confirm room creation, immediate turn streaming, task-specific synthesis, and plan room limit.
- [ ] Verify dashboard outcomes counts stay organization-scoped.
- [ ] Connect a dedicated test Gmail account, send only to an approved test inbox, then confirm inbound reply updates the ledger exactly once.
- [ ] Test TARA with a deliberately disallowed number first; only test a real call after an explicit allowlist and consent check.
- [ ] Verify Usage and Billing show backend-authoritative plan, usage, and gates. Do not create a payment unless intentionally testing Stripe.
- [ ] On desktop and mobile, hard-refresh once and confirm the current tool-activity UI and navigation labels are served.

## Current test status

- Passed on `2026-07-14`: authenticated bootstrap, teams, projects, org projects, outcomes, and company context for the MANDI tenant; public homepage, login, Overview, API/Core/TARA health; release image and frontend chunk markers; fresh fatal/unhandled log check.
- Passed on `2026-07-14`: authenticated MANDI document browser returned all `37` parsed documents through the live `/v1/proxy/documents` contract. The tenant has `937` source segments and `199` evidence links in the active `hivemind` schema.
- Observed on `2026-07-14`: MANDI fact recall for `what do you know about me` returned `200` in `1.57s` with `cutoff_reason=latency_budget` and no memory/evidence. This was an unrelated query, not data loss: the same tenant has source records. Repeat using a known document title or durable memory before diagnosing retrieval.
- Remaining policy check: verify that an authorized non-uploader organization member sees the intended shared documents. The list route currently scopes by both user and organization, so this must be an explicit product decision before widening access.
- Still required: user-driven UI flow, document ingest/recall/chat evidence, HyperAgents room run, Gmail reply loop with a dedicated test connection, optional permitted TARA call, and Stripe checkout only when a deliberate payment test is requested.

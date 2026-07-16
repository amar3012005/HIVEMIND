# Outreach Campaign Runner — Design Spec

Date: 2026-07-16 · Status: APPROVED (user, this session)
Scope: post-report execution pipeline — one-click "Send outreach emails" / "Start outreach calls" with one-by-one progress, stop/deselect, per-prospect personalization, TARA per-prospect call goals.

## Decisions (locked)

1. **Hybrid control** — BE owns a durable campaign (created atomically on click); FE drives pace/progress/stop/deselect while open; BE drain-fallback finishes stragglers if the tab dies.
2. **Per-prospect personalized emails** — each target gets its own generated email from the sealed report + that firm's specifics. No shared template.
3. **Call goals auto-derived, user-editable** — pipeline generates per-prospect `{goal, opener}` from report + firm data; editable inline before dialing.
4. **Independent triggers** — separate "Send emails" and "Start calls" buttons; each runs its own campaign over its own eligible set (email needs verified email; call needs phone).
5. **Generalized subsystem, outreach-room-first** — keyed on the sealed turn's `prospects` artifact, NOT `room.kind`. Any room that surfaces prospects gets the buttons. Proven in the outreach room first.
6. **Sequence A-then-B** — this pipeline (stage 5, act) ships first; Dropcontact enrichment (stage 3, contacts) is the next feature-loop after.

## Data model (core Postgres, Prisma)

### `OutreachCampaign` — one per click
| field | type | notes |
|---|---|---|
| id | uuid pk | |
| roomId, turnId | uuid | source seal |
| userId, orgId | uuid | tenant scoping — ALL queries scoped |
| channel | varchar(8) | `email` \| `call` |
| status | varchar(12) | `queued` \| `running` \| `paused` \| `done` \| `cancelled` |
| senderEmail | varchar(160)? | connected Gmail (email channel), via `get_connected_gmail` |
| taraNumber | varchar(32)? | outbound caller id (call channel) |
| createdAt, startedAt?, finishedAt? | timestamptz | |
| lastTickAt | timestamptz? | drain-worker liveness signal |

### `OutreachTarget` — one per prospect per campaign
| field | type | notes |
|---|---|---|
| id | uuid pk | |
| campaignId | fk → OutreachCampaign, cascade | |
| position | int | run order |
| company, email?, phone?, website?, address? | text | snapshot from `prospects` event at click time |
| payload | jsonb? | email: `{subject, body}` · call: `{goal, opener}` — user-editable until executed |
| state | varchar(12) | `selected` \| `deselected` \| `generating` \| `ready` \| `sending` \| `sent` \| `failed` \| `skipped` |
| resultRef | jsonb? | `{outboundActionId}` or `{taraCallLegId}` + `{error}` |
| updatedAt | timestamptz | |

Indexes: `(campaignId, position)`, `(campaignId, state)`, campaign `(userId, status, createdAt)`.

**Reuse, not duplication:** `OutboundAction` stays the per-send outcome ledger (reply-match, outcomes strip). `OutreachTarget` adds pre-send state (selection, generation, editing) that doesn't belong in a sent-ledger. Existing single-write approval cards remain for one-off sends; campaigns are the batch path.

## API (control-plane routes → employees sidecar where LLM needed)

| route | does |
|---|---|
| `POST /api/hyper/rooms/:roomId/campaigns` `{channel, turn_id}` | snapshot eligible prospects → campaign + targets (`selected`), resolve senderEmail/taraNumber, return full campaign |
| `GET /api/campaigns/:id` | campaign + targets (poll fallback) |
| `POST /api/campaigns/:id/start` · `/stop` | status transitions; stop → `paused` (finish current in-flight item, no new starts) |
| `PATCH /api/campaigns/:id/targets/:tid` | deselect/reselect; edit payload (only while not `sending`/`sent`) |
| `POST /api/campaigns/:id/targets/:tid/generate` | sidecar generates personalized email or call-goal → `ready` |
| `POST /api/campaigns/:id/targets/:tid/execute` | email: Gmail send via google-native → `OutboundAction` → `sent`. call: TARA `POST /calls/outbound` with goal directive → `sent` on call end |
| `GET /api/campaigns/:id/events` (SSE) | state ticks for progress bar (poll fallback acceptable v1) |

All routes auth'd + tenant-scoped (userId/orgId from session, never from body).

## Generation (employees sidecar)

- **Email**: prompt = sealed report body + firm row (company/why-fit/website) + SENDER IDENTITY contract (shipped `prod-20260716-c459a086`): sign-off with real connected address, explicit `Subject:` line, one why-now hook, one value point, one ask, no placeholders. Output `{subject, body}`; subject extraction reuses the shipped Subject:-preferring logic.
- **Call**: prompt = report + firm row → `{goal, opener}` (goal: outcome-framed one-liner e.g. "book a 15-min intro re EU-AI-compliance"; opener: first spoken line referencing the firm). Injected into TARA voice-v2 router directive seam per call.

## Run semantics

- FE loop, strictly one-by-one in `position` order over `selected` targets: generate → (render for optional inline edit) → execute → tick progress.
- Email throttle ≥8s between sends (Gmail heuristics). Hard cap 50 targets/campaign.
- Calls strictly serial (TARA is one voice); live per-card status: dialing → in-call → ended; call-end webhook (existing) writes insight + `OutboundAction(kind='call')`.
- **Stop**: current in-flight item finishes; campaign `paused`; resume re-enters loop at next `selected`. **Deselect** mid-run: loop skips.
- **Drain worker** (employees sidecar scheduler, existing cron pattern): campaign `running` with `lastTickAt` idle >5 min → BE finishes remaining `selected/ready` targets (generate+execute) itself. Idempotency: a `sending` target older than 10 min re-checks `OutboundAction` before any retry — the ledger is send-truth; never double-send.
- No auto-redial on call no-answer in v1: mark `failed:no-answer`; user may re-run failed subset.

## Errors

- Generation failure → target `failed`, loop continues (one bad LLM call never blocks the batch).
- Gmail 401/expired → campaign auto-`paused`, FE surfaces "reconnect Gmail"; remaining targets preserved.
- TARA/Telnyx dial error → target `failed`, continue.
- Every failure stores `resultRef.error` verbatim for the card.

## FE (Da-vinci, HyperAgents.jsx + shared module)

- Sealed turn with ≥1 eligible prospect → buttons under the prospect stack: **"Send outreach emails (N)"** (N = email-verified count), **"Start outreach calls (M)"** (M = has-phone count).
- **Campaign panel**: target list (checkbox select/deselect, expandable payload editor), progress bar `k/N` with per-state coloring, Start / Stop / Resume, per-card status chip (✓ sent · ✗ failed + reason · ⏭ skipped · 📞 dialing/in-call).
- Component is room-agnostic (keyed on `prospects` artifact), shipped in the shared hyperagents module.

## Testing

- Unit: campaign state machine transitions (all legal/illegal moves), eligibility filters, throttle, cap.
- Integration: create→start→stop→resume→drain roundtrip against test DB; Gmail + TARA mocked (never real APIs in tests).
- Migration: up AND down tested.
- E2E (manual gate before ship): one real campaign of 2 targets to amarsai2005@gmail.com per HyperAgents test-recipient rule; one real TARA call to owner's number.

## Non-goals (v1)

Sequenced email→call plays, auto-redial, multi-user concurrent campaign editing, LinkedIn channel, Dropcontact enrichment (next feature-loop), scheduling/nightly cycle.

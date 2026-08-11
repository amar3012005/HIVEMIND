# P6 — Outreach / TARA autonomy: the human gate (READ before enabling anything)

**Status:** guardrails shipped (default-neutral). Autonomous *origination* NOT built — it
requires an explicit human product decision + P0 provenance live. This doc is that gate.

## What shipped (safe, default-neutral)
`core/src/outreach/outreach-contract.js` + a guard at `campaigns.js executeTarget` (the one
send choke point for BOTH the FE lane and the autonomous drain worker):
- **Kill switch:** `HYPER_KILL_SWITCH` (Governor global) or `HYPER_OUTREACH_KILL_SWITCH` →
  every outreach send is skipped (marked 'skipped', reason logged). Instant, no DB write.
- **Daily cap:** `HYPER_OUTREACH_DAILY_CAP` (0 = unlimited default) → per-org rolling-24h send
  ceiling, on top of the existing HARD cross-campaign dedup ("never email the same address
  twice") + per-campaign pacing.
- Provenance (P0): every send already goes through `recordOutboundAction` (org/user/room/channel
  /recipient) — the audit trail the contract assumes.

Defaults change NOTHING: kill off, cap 0. Enabling a cap or the kill switch is a safe operator action.

## What is GATED (do NOT enable without an explicit owner decision)
"TARA autonomy" in the full sense = the OS **originating** outreach on its own (deciding whom
to contact and sending, with no human "Send" click). That is deliberately NOT implemented.
Today the drain worker only ADVANCES a campaign a human created; it never originates.

Before any autonomous origination is built/enabled, ALL of these must be true (owner-gated):
1. **P0 provenance is live** (columns applied or source_metadata verified) so every autonomous
   contact is fully traceable to a decision + turn.
2. **Explicit per-org opt-in** to autonomous outreach (a stored authorization, not an env flag).
3. **HITL remains for first-contact** — a human approves the target list / template before the
   first autonomous send to a new audience. No cold mass send without a human sign-off.
4. **Volume + rate caps enforced** (P2 outbound cap + this daily cap) with conservative defaults.
5. **Kill switch tested** and reachable by a non-engineer operator.
6. **Consent/legal review** of the recipient source (no scraped/mass lists; anti-spam compliant).

This is an outward-facing, hard-to-reverse capability (real emails/calls to real people). Per
the standing rules it is human-gated: the owner must explicitly authorize building/enabling it.

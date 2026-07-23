// P6 — Outreach Autonomy Contract.
//
// The single safety contract every outbound outreach send (email/call) must pass, on BOTH
// the FE-driven lane and the autonomous drain worker. It ties the OS's guardrails together
// at the one send choke point (campaigns.js executeTarget):
//   • Kill switch (P2)   — an operator can stop ALL outreach instantly, no DB write.
//   • Daily volume cap   — bounds how much a single org sends per rolling day (anti-runaway,
//                          anti-spam) on top of the existing hard cross-campaign dedup + pacing.
//   • Provenance (P0)    — every send is already recorded via recordOutboundAction; this
//                          contract is where that invariant is asserted for the audit trail.
//
// Autonomy boundary: the drain worker only ever ADVANCES a campaign a human already created
// (the "Send outreach" click). It NEVER originates outreach on its own — origination stays a
// human action. This module does not change that; it adds the stop/cap levers on top.
//
// Defaults are behavior-NEUTRAL: kill switch off, daily cap 0 (unlimited). Enabling either is
// an explicit operator action. Enabling any *new* autonomous origination is a product decision
// that requires an explicit human gate — it is intentionally NOT implemented here.

export const OUTREACH_CONTRACT_VERSION = '1';

function _truthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
}

/** Master stop for outreach — the Governor's global kill switch OR an outreach-specific one. */
export function outreachKillSwitchActive() {
  return _truthy(process.env.HYPER_KILL_SWITCH) || _truthy(process.env.HYPER_OUTREACH_KILL_SWITCH);
}

/** Per-org rolling-24h send cap. 0 = unlimited (default). */
export function outreachDailyCap() {
  const n = parseInt(process.env.HYPER_OUTREACH_DAILY_CAP || '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Decide whether an outreach send may proceed. Pure + synchronous — the caller supplies
 * `sentToday` (only queried when a cap is configured, so the hot path pays nothing by default).
 * @param {{campaign: Object, sentToday?: number}} args
 * @returns {{allowed: boolean, reason: string}}
 */
export function assertOutreachAllowed({ campaign, sentToday = 0 } = {}) {
  if (outreachKillSwitchActive()) return { allowed: false, reason: 'kill_switch' };
  if (!campaign || !campaign.id) return { allowed: false, reason: 'no_campaign' };
  const cap = outreachDailyCap();
  if (cap && sentToday >= cap) return { allowed: false, reason: `daily_cap_reached(${cap})` };
  return { allowed: true, reason: 'ok' };
}

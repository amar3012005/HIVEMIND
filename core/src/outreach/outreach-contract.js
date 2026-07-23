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
 * Autonomous execution switch for the drain worker (HYPER_OUTREACH_AUTONOMY).
 * Default ON = the OS autonomously ADVANCES + EXECUTES campaigns a human already
 * authorized (the "Send outreach" click). Set to off to require the FE to drive
 * every send (no background autonomy). This is the ONLY autonomy in the system.
 *
 * HARD SAFETY INVARIANT (assertAutonomousSendAllowed): autonomy NEVER originates
 * cold outreach. The drain may only advance a 'running' campaign — and a campaign
 * exists solely because a human created + started it after reviewing the prospects
 * (first-contact HITL). There is deliberately NO code path for the OS to build a
 * target list and send with no human approval (consent / deliverability / legal).
 */
/**
 * Auto-propose switch (HYPER_OUTREACH_AUTO_PROPOSE, default off). When on, the OS may
 * auto-GENERATE a campaign from a room turn's eligible prospects — but ALWAYS in the
 * 'queued' (proposed) state. It is NEVER auto-started: a human must Start it (first-contact
 * HITL), and the drain only ever sends 'running' campaigns. So enabling this lets the OS
 * do the tedious target-assembly while the human keeps the go/no-go on every first contact.
 */
export function outreachAutoProposeEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.HYPER_OUTREACH_AUTO_PROPOSE || '').trim().toLowerCase());
}

export function outreachAutonomyEnabled() {
  return String(process.env.HYPER_OUTREACH_AUTONOMY || 'on').trim().toLowerCase() !== 'off'
    && !['0', 'false', 'no'].includes(String(process.env.HYPER_OUTREACH_AUTONOMY || '').trim().toLowerCase());
}

/**
 * Gate an AUTONOMOUS (drain-worker) send. Enforces the first-contact-HITL invariant:
 * only a human-authorized, running campaign may be auto-advanced. Never cold-originates.
 * @param {{campaign: Object}} args
 * @returns {{allowed: boolean, reason: string}}
 */
export function assertAutonomousSendAllowed({ campaign } = {}) {
  if (!outreachAutonomyEnabled()) return { allowed: false, reason: 'autonomy_disabled' };
  if (!campaign || !campaign.id) return { allowed: false, reason: 'no_campaign' };
  // A campaign only exists because a human created + started it (first-contact HITL).
  if (campaign.status !== 'running') return { allowed: false, reason: 'campaign_not_running' };
  return { allowed: true, reason: 'ok' };
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

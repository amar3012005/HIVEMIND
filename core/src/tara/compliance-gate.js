/**
 * TARA Outbound — compliance gate.
 *
 * Pure, deterministic decision function evaluated BEFORE every dial. The
 * default is ALWAYS don't-call: a contact is only cleared when it passes every
 * stage, in this fixed order (the flowchart IS the test matrix):
 *
 *   1. DNC            — phone on the org do-not-call list  → block
 *   2. lawful basis   — must be a recognised GDPR basis    → block
 *   3. country rule   — B2B legitimate-interest allowed in IE/NL/FR;
 *                       DE/IT are B2C-restricted → skip; consent overrides;
 *                       unknown country → block
 *   4. calling hours  — within the campaign window in the CONTACT's timezone
 *   5. caps           — concurrency + daily caps not exceeded
 *
 * No side effects, no I/O — callers pass in all state (dncSet, counters, now)
 * so this is trivially unit-testable and replica-safe.
 */

/** Recognised GDPR lawful bases for outbound contact. */
export const LAWFUL_BASES = Object.freeze(['legitimate_interest', 'consent']);

/** B2B legitimate-interest is permitted in these countries (P0 decision). */
export const DEFAULT_B2B_COUNTRIES = Object.freeze(['IE', 'NL', 'FR']);

/** B2C-restricted markets — deferred; legitimate-interest is skipped here. */
export const DEFAULT_B2C_RESTRICTED = Object.freeze(['DE', 'IT']);

const DECISION = (allow, stage, reason) => ({ allow, stage, reason });

/**
 * Resolve the wall-clock hour (0-23) and weekday (0=Sun..6=Sat) for a given
 * instant in an IANA timezone, using stdlib Intl only.
 * @param {Date} now
 * @param {string} timeZone IANA tz, e.g. "Europe/Dublin"
 * @returns {{ hour: number, weekday: number }}
 */
export function localClock(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);
  const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '00';
  let hour = parseInt(hourPart, 10);
  if (hour === 24) hour = 0; // some ICU builds emit "24" for midnight
  const wdName = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wdName] ?? 0;
  return { hour, weekday };
}

/**
 * Evaluate the compliance gate for one contact on one campaign.
 *
 * @param {object} params
 * @param {object} params.contact   { phone, country, lawfulBasis, timezone }
 * @param {object} [params.campaign] { callingWindow, caps, complianceConfig }
 * @param {Set<string>} [params.dncSet]      org DNC phones (E.164)
 * @param {number} [params.concurrency]      calls currently in flight
 * @param {number} [params.todayCount]       calls already placed today
 * @param {Date}   [params.now]              evaluation instant (default: real now)
 * @returns {{ allow: boolean, stage: string, reason: string }}
 */
export function evaluateGate({
  contact,
  campaign = {},
  dncSet = new Set(),
  concurrency = 0,
  todayCount = 0,
  now = new Date(),
} = {}) {
  if (!contact || typeof contact.phone !== 'string' || !contact.phone) {
    return DECISION(false, 'input', 'missing contact phone');
  }

  const cfg = campaign.complianceConfig ?? {};
  const b2bCountries = (cfg.b2bCountries ?? DEFAULT_B2B_COUNTRIES).map((c) => c.toUpperCase());
  const b2cRestricted = (cfg.b2cRestricted ?? DEFAULT_B2C_RESTRICTED).map((c) => c.toUpperCase());

  // 1. DNC — hard block.
  if (dncSet.has(contact.phone)) {
    return DECISION(false, 'dnc', 'phone is on the do-not-call list');
  }

  // 2. Lawful basis — must be recognised.
  const basis = contact.lawfulBasis;
  if (!LAWFUL_BASES.includes(basis)) {
    return DECISION(false, 'lawful_basis', `no recognised lawful basis (got: ${basis ?? 'none'})`);
  }

  // 3. Country rule. Explicit consent overrides geographic restriction.
  const country = (contact.country ?? '').toUpperCase();
  if (basis !== 'consent') {
    if (!country) {
      return DECISION(false, 'country', 'country unknown — cannot establish lawful basis');
    }
    if (b2cRestricted.includes(country)) {
      return DECISION(false, 'country', `${country} is B2C-restricted (deferred)`);
    }
    if (!b2bCountries.includes(country)) {
      return DECISION(false, 'country', `${country} not in allowed B2B list`);
    }
  }

  // 4. Calling hours — in the contact's timezone.
  const win = campaign.callingWindow ?? {};
  const tz = contact.timezone || win.tz;
  if (!tz) {
    return DECISION(false, 'calling_hours', 'no timezone for contact — cannot verify calling hours');
  }
  let clock;
  try {
    clock = localClock(now, tz);
  } catch {
    return DECISION(false, 'calling_hours', `invalid timezone: ${tz}`);
  }
  const startHour = Number.isInteger(win.startHour) ? win.startHour : 9;
  const endHour = Number.isInteger(win.endHour) ? win.endHour : 20;
  const allowedDays = Array.isArray(win.days) ? win.days : [1, 2, 3, 4, 5]; // Mon-Fri
  if (!allowedDays.includes(clock.weekday)) {
    return DECISION(false, 'calling_hours', `day ${clock.weekday} outside allowed days`);
  }
  if (clock.hour < startHour || clock.hour >= endHour) {
    return DECISION(false, 'calling_hours', `local hour ${clock.hour} outside [${startHour},${endHour})`);
  }

  // 5. Caps.
  const caps = campaign.caps ?? {};
  const maxConcurrency = Number.isInteger(caps.concurrency) ? caps.concurrency : 1;
  const dailyMax = Number.isInteger(caps.dailyMax) ? caps.dailyMax : Infinity;
  if (concurrency >= maxConcurrency) {
    return DECISION(false, 'caps', `concurrency ${concurrency} >= cap ${maxConcurrency}`);
  }
  if (todayCount >= dailyMax) {
    return DECISION(false, 'caps', `daily count ${todayCount} >= cap ${dailyMax}`);
  }

  return DECISION(true, 'cleared', 'all compliance checks passed');
}

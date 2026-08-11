/**
 * Runway scope pricing — the server-authoritative version of the FE Sovereign
 * Scope Estimator (frontend/Da-vinci/src/components/hivemind/cartesia/Pricing.jsx).
 *
 * The runway phase (after the 2-week enterprise onboarding) is self-serve: the org
 * configures deployment mode + data/seats/tokens, we compute the monthly price HERE
 * (never trust the client's number), charge it via Stripe, and on payment activate a
 * CUSTOM recurring entitlement whose limits match the chosen scope. Keep this math
 * byte-for-byte in sync with Pricing.jsx `ScopeEstimator.calc`.
 */

const CLAMP = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

// Slider bounds — mirror the FE sliders so a hand-crafted request can't price abuse.
export const RUNWAY_BOUNDS = {
  dataGb: { min: 50, max: 5000 },
  seats: { min: 1, max: 500 },
  tokens: { min: 1, max: 500 }, // millions/month
};

export function normalizeRunwayConfig(raw = {}) {
  const mode = raw.mode === 'self-hosted' ? 'self-hosted' : 'managed';
  return {
    mode,
    dataGb: CLAMP(raw.dataGb ?? raw.data_gb, RUNWAY_BOUNDS.dataGb.min, RUNWAY_BOUNDS.dataGb.max),
    seats: CLAMP(raw.seats, RUNWAY_BOUNDS.seats.min, RUNWAY_BOUNDS.seats.max),
    tokens: CLAMP(raw.tokens, RUNWAY_BOUNDS.tokens.min, RUNWAY_BOUNDS.tokens.max),
  };
}

/** Compute the runway quote. Returns { mode, config, currency, rows, monthlyTotal, setupOneTime }. */
export function computeRunwayQuote(raw = {}) {
  const cfg = normalizeRunwayConfig(raw);
  const { mode, dataGb, seats, tokens } = cfg;
  const seatCost = seats * 18;
  const tokenCost = tokens * 6;
  if (mode === 'managed') {
    const storage = Math.round(dataGb * 0.4);
    const monthlyTotal = storage + seatCost + tokenCost;
    return {
      mode, config: cfg, currency: 'EUR',
      rows: [
        ['Managed storage', `${dataGb}GB @ €0.40/GB`, storage],
        ['User seats', `${seats} @ €18/seat`, seatCost],
        ['Token processing', `${tokens}M @ €6/M`, tokenCost],
      ],
      monthlyTotal, setupOneTime: 0,
    };
  }
  const license = 5500;
  const opsSurcharge = 2100;
  const monthlyTotal = license + seatCost + tokenCost + opsSurcharge;
  return {
    mode, config: cfg, currency: 'EUR',
    rows: [
      ['Sovereign license + remote support', 'flat', license],
      ['Storage: your own infrastructure', '—', 0],
      ['User seats', `${seats} @ €18/seat`, seatCost],
      ['Token processing', `${tokens}M @ €6/M`, tokenCost],
      ['Self-hosted ops surcharge', 'audits, deployment eng, air-gap mgmt', opsSurcharge],
    ],
    monthlyTotal, setupOneTime: 27500,
  };
}

/**
 * Derive the entitlement limit overrides for a chosen scope. The runway plan sits on
 * the `enterprise` base plan (so features/gates read enterprise), with the numeric
 * caps set to what the org actually paid for. Rooms stay at the enterprise default
 * (the scope prices data/seats/tokens, not rooms) so a paying runway org is never
 * blocked from its OS.
 */
export function runwayLimitOverrides(raw = {}) {
  const { seats, tokens, dataGb } = normalizeRunwayConfig(raw);
  return {
    maxUsers: seats,
    llmTokensPerMonth: tokens * 1_000_000,
    llmTokensPerDay: Math.max(100_000, Math.round((tokens * 1_000_000) / 30)),
    // ~1 memory per 4KB of the data pack, floored generously; never below scale tier.
    maxMemories: Math.max(250_000, dataGb * 2_000),
  };
}

/**
 * Build the offer `activateOffer` consumes for a PAID runway subscription: a single
 * runway phase (onboarding_days:0) on the enterprise plan with the scope's custom
 * limits, recurring until changed. `activateOffer` writes the entitlement + flips the
 * org to active.
 */
export function buildRunwayOffer(raw = {}, quote = null) {
  const q = quote || computeRunwayQuote(raw);
  return {
    kind: 'runway',
    target_plan: 'enterprise',
    onboarding_days: 0,
    onboarding_plan: 'enterprise',
    onboarding_limits: {},
    runway_plan: 'enterprise',
    runway_limits: runwayLimitOverrides(raw),
    scope: q.config,
    monthly_total: q.monthlyTotal,
    setup_one_time: q.setupOneTime,
    currency: q.currency,
    quoted_at: new Date().toISOString(),
  };
}

/**
 * Phase E — shared cognition token budget pool.
 *
 * Instead of three independent per-agent daily budgets (faraday/feynman/turing),
 * Phase E introduces ONE org-wide pool row in hivemind.governance_agent_state
 * under the synthetic agent name '__pool__'. All cognitive tiers (synthesis,
 * bridge, compaction, evolution) debit the same pool, and a tier is only run if
 * it can afford its conservative token estimate. This caps total daily cognition
 * cost regardless of how the work is split across tiers.
 *
 * Reuses the EXISTING governance_agent_state columns (tokens_spent_today,
 * daily_token_budget, token_budget_reset_at) — NO schema change. Int columns are
 * safe under the 1M default budget.
 *
 * Flag-gated (default OFF): when PHASE_E_BUDGET_POOL!=='true', isPoolEnabled()
 * returns false and affordTier() always returns true, so callers behave exactly
 * as before.
 *
 * Environment:
 *   PHASE_E_BUDGET_POOL        '=true' to enable the shared pool (default OFF)
 *   PHASE_E_POOL_DAILY_BUDGET  daily token budget for the pool (default 1_000_000)
 *   PHASE_E_EST_SYNTHESIS      per-tier token estimate (default 8000)
 *   PHASE_E_EST_BRIDGE         (default 20000)
 *   PHASE_E_EST_COMPACTION     (default 30000)
 *   PHASE_E_EST_EVOLUTION      (default 4000)
 *
 * @module resident/budget-pool
 */

/** Synthetic agent_name used for the shared pool row. */
export const POOL_AGENT_NAME = '__pool__';

/** @returns {boolean} whether the Phase E shared budget pool is enabled */
export function isPoolEnabled() {
  return process.env.PHASE_E_BUDGET_POOL === 'true';
}

/** Daily token budget for the shared pool. */
export const POOL_DAILY_BUDGET = Number(process.env.PHASE_E_POOL_DAILY_BUDGET || 1_000_000);

/**
 * Conservative per-tier token estimate. Overridable via PHASE_E_EST_<TIER>.
 * @param {string} tierName
 * @returns {number}
 */
function estForTier(tierName) {
  switch (tierName) {
    case 'bridge':     return Number(process.env.PHASE_E_EST_BRIDGE     || 20000);
    case 'compaction': return Number(process.env.PHASE_E_EST_COMPACTION || 30000);
    case 'evolution':  return Number(process.env.PHASE_E_EST_EVOLUTION  || 4000);
    case 'synthesis':
    default:           return Number(process.env.PHASE_E_EST_SYNTHESIS  || 8000);
  }
}

/**
 * Ensure the pool row exists. Idempotent (ON CONFLICT DO NOTHING).
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<void>}
 */
export async function ensurePoolRow(prisma) {
  if (!prisma) return;
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO hivemind.governance_agent_state
         (agent_name, tokens_spent_today, daily_token_budget, token_budget_reset_at, updated_at)
       VALUES ($1, 0, $2, CURRENT_DATE, now())
       ON CONFLICT (agent_name) DO NOTHING`,
      POOL_AGENT_NAME,
      POOL_DAILY_BUDGET,
    );
  } catch (err) {
    // Re-thrown so callers (affordTier/run-manager) can decide to fail open.
    throw err;
  }
}

/**
 * Run the same day-reset UPDATE as run-manager (scoped to the pool row), then
 * read current spend/budget.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<{spent:number,budget:number,remaining:number,exhausted:boolean}>}
 */
export async function resetAndReadPool(prisma) {
  if (!prisma) return { spent: 0, budget: POOL_DAILY_BUDGET, remaining: POOL_DAILY_BUDGET, exhausted: false };
  await prisma.$executeRawUnsafe(
    `UPDATE hivemind.governance_agent_state
        SET tokens_spent_today = 0,
            token_budget_reset_at = CURRENT_DATE
      WHERE agent_name = $1
        AND token_budget_reset_at < CURRENT_DATE`,
    POOL_AGENT_NAME,
  );
  const rows = await prisma.$queryRawUnsafe(
    `SELECT tokens_spent_today, daily_token_budget
       FROM hivemind.governance_agent_state
      WHERE agent_name = $1`,
    POOL_AGENT_NAME,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  const spent = Number(row?.tokens_spent_today ?? 0);
  const budget = Number(row?.daily_token_budget ?? POOL_DAILY_BUDGET);
  const remaining = budget - spent;
  return { spent, budget, remaining, exhausted: remaining <= 0 };
}

/**
 * Whether a tier's estimated cost fits the remaining pool budget. Returns true
 * when the pool is disabled (no gating). estTokens defaults to the tier estimate.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} tierName
 * @param {number} [estTokens]
 * @returns {Promise<boolean>}
 */
export async function affordTier(prisma, tierName, estTokens) {
  if (!isPoolEnabled()) return true;
  if (!prisma) return true;
  const est = Number.isFinite(estTokens) ? Number(estTokens) : estForTier(tierName);
  try {
    await ensurePoolRow(prisma);
    const { remaining } = await resetAndReadPool(prisma);
    return remaining >= est;
  } catch {
    // On any error, fail OPEN (allow the tier) — the pool is an advisory cap,
    // not a hard correctness gate.
    return true;
  }
}

/**
 * Debit the shared pool. Single atomic UPDATE; never throws.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} tokens
 * @param {string} tierName  (recorded only in the optional warn log)
 * @param {{warn?:(msg:string)=>void}} [logger]
 * @returns {Promise<void>}
 */
export async function spendPool(prisma, tokens, tierName, logger = console) {
  if (!prisma) return;
  const amount = Number(tokens) || 0;
  if (amount <= 0) return;
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE hivemind.governance_agent_state
          SET tokens_spent_today = tokens_spent_today + $1,
              updated_at = now()
        WHERE agent_name = $2`,
      amount,
      POOL_AGENT_NAME,
    );
  } catch (err) {
    logger?.warn?.(`[budget-pool] spend failed (tier=${tierName}, tokens=${amount}): ${err.message}`);
  }
}

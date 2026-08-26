import crypto from 'node:crypto';
import { usageMetric } from './metric-registry.js';

// Canonical append-only operation writer. OrgUsage remains the settled usage
// projection used by the Usage page and by commercial credit calculation.
export class UsageService {
  constructor({ prisma, planEnforcer, usageTracker }) {
    this.prisma = prisma;
    this.planEnforcer = planEnforcer;
    this.usageTracker = usageTracker;
  }

  async admit({ orgId, userId = null, apiKeyId = null, type, quantity = 1, source = 'product', idempotencyKey, providerReceipt = null, metadata = {} }) {
    const descriptor = usageMetric(type);
    if (!descriptor || !orgId || !(Number(quantity) > 0)) throw new Error('invalid usage admission');
    const key = String(idempotencyKey || crypto.randomUUID()).slice(0, 180);
    // Retried requests must return their original admission before evaluating
    // today's remaining allowance. Otherwise a harmless retry at a hard cap
    // looks like a new charge and becomes incorrectly non-retryable.
    const existing = await this.prisma.$queryRawUnsafe(
      `SELECT id, state, metric, quantity FROM hivemind.usage_events
       WHERE org_id = $1::uuid AND idempotency_key = $2 LIMIT 1`, orgId, key,
    );
    if (existing[0]) {
      if (existing[0].metric !== descriptor.metric || Number(existing[0].quantity) !== Number(quantity)) {
        throw new Error('usage idempotency key does not match original operation');
      }
      return { admitted: true, event: existing[0], idempotencyKey: key, duplicate: true };
    }
    const check = await this.planEnforcer?.checkLimit(orgId, type, Number(quantity));
    if (check && !check.allowed) return { admitted: false, check };
    const rows = await this.prisma.$queryRawUnsafe(
      `INSERT INTO hivemind.usage_events (org_id, initiating_user_id, api_key_id, source, metric, quantity, state, idempotency_key, provider_receipt, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::bigint, 'reserved', $7, $8::jsonb, $9::jsonb)
       ON CONFLICT (org_id, idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id, state, metric, quantity`, orgId, userId, apiKeyId, String(source).slice(0, 80), descriptor.metric,
      Number(quantity), key, JSON.stringify(providerReceipt || {}), JSON.stringify(metadata || {}),
    );
    return { admitted: true, event: rows[0], idempotencyKey: key };
  }

  async settle({ orgId, idempotencyKey }) {
    const rows = await this.prisma.$queryRawUnsafe(
      `UPDATE hivemind.usage_events SET state = 'settled', settled_at = NOW()
       WHERE org_id = $1::uuid AND idempotency_key = $2 AND state = 'reserved'
       RETURNING id, metric, quantity, api_key_id, source, metadata`, orgId, idempotencyKey,
    );
    if (!rows[0]) return { settled: false, duplicate: true };
    const event = rows[0];
    // The projection receipt is independent from retries. It is intentionally
    // inserted before projection work, so only one concurrent settle proceeds.
    const receipt = await this.prisma.$queryRawUnsafe(
      `INSERT INTO hivemind.usage_projection_receipts (usage_event_id) VALUES ($1::uuid)
       ON CONFLICT DO NOTHING RETURNING usage_event_id`, event.id,
    );
    if (receipt[0]) await this._applyProjection(orgId, event.metric, Number(event.quantity), event);
    return { settled: true, event };
  }

  async release({ orgId, idempotencyKey }) {
    await this.prisma.$executeRawUnsafe(
      `UPDATE hivemind.usage_events SET state = 'released', released_at = NOW()
       WHERE org_id = $1::uuid AND idempotency_key = $2 AND state = 'reserved'`, orgId, idempotencyKey,
    );
  }

  async record({ orgId, userId = null, apiKeyId = null, type, quantity = 1, source = 'product', idempotencyKey, providerReceipt = null, metadata = {} }) {
    const admitted = await this.admit({ orgId, userId, apiKeyId, type, quantity, source, idempotencyKey, providerReceipt, metadata });
    if (!admitted.admitted) return admitted;
    return { ...admitted, ...(await this.settle({ orgId, idempotencyKey: admitted.idempotencyKey })) };
  }

  async getMemberSummary(orgId, userId) {
    return this.prisma.$queryRawUnsafe(
      `SELECT metric, source, SUM(quantity)::text AS quantity
       FROM hivemind.usage_events WHERE org_id = $1::uuid AND initiating_user_id = $2::uuid AND state = 'settled'
       GROUP BY metric, source ORDER BY metric, source`, orgId, userId,
    );
  }

  async _applyProjection(orgId, metric, quantity, event = {}) {
    const entry = Object.entries((await import('./metric-registry.js')).USAGE_METRICS).find(([, value]) => value.metric === metric)?.[1];
    if (!entry || !entry.month || !entry.daily) return;
    const month = new Date().toISOString().slice(0, 7);
    const day = new Date().toISOString().slice(0, 10);
    const m = entry.month, d = entry.daily, c = entry.cumulative;
    // Keep projection atomic without an interactive Prisma transaction. Under
    // concurrent chat settlement the former three round trips could wait on a
    // row lock until Prisma's 5s transaction lease expired, producing a noisy
    // P2028 even though the user-facing turn had already succeeded. One DML CTE
    // is one server-side statement/transaction and cannot expire between
    // projection queries.
    const cumulativeCte = c
      ? `, cumulative_projection AS (
          INSERT INTO hivemind.org_usage_cumulative (org_id, "${c}") VALUES ($1::uuid, $4)
          ON CONFLICT (org_id) DO UPDATE SET "${c}" = hivemind.org_usage_cumulative."${c}" + $4, updated_at = NOW()
          RETURNING 1
        )`
      : '';
    await this.prisma.$queryRawUnsafe(
      `WITH monthly_projection AS (
         INSERT INTO "OrgUsage" ("orgId", "month", "${m}", "updatedAt") VALUES ($1::uuid, $2, $4, NOW())
         ON CONFLICT ("orgId", "month") DO UPDATE SET "${m}" = "OrgUsage"."${m}" + $4, "updatedAt" = NOW()
         RETURNING 1
       ), daily_projection AS (
         INSERT INTO "OrgUsageDaily" ("orgId", "day", "${d}", "updatedAt") VALUES ($1::uuid, $3::date, $4, NOW())
         ON CONFLICT ("orgId", "day") DO UPDATE SET "${d}" = "OrgUsageDaily"."${d}" + $4, "updatedAt" = NOW()
         RETURNING 1
       )${cumulativeCte}
       SELECT 1 AS projected`,
      orgId, month, day, quantity,
    );
    if (metric === 'tokens') {
      const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
      await this.usageTracker?.recordKeyUsage?.(
        orgId,
        quantity,
        event.api_key_id || null,
        metadata.model || null,
        metadata.feature || event.source || null,
        {
          promptTokens: Number(metadata.prompt_tokens || 0),
          completionTokens: Number(metadata.completion_tokens || 0),
        },
      );
    }
    this.usageTracker?._invalidateCache?.(orgId);
  }
}

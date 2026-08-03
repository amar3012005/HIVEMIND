import crypto from 'node:crypto';
import { usageMetric } from './metric-registry.js';

// Canonical append-only usage writer. Legacy counters remain projections for
// fast UI reads, but only a successful settlement advances them after cutover.
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
       RETURNING id, metric, quantity`, orgId, idempotencyKey,
    );
    if (!rows[0]) return { settled: false, duplicate: true };
    const event = rows[0];
    // The projection receipt is independent from retries. It is intentionally
    // inserted before projection work, so only one concurrent settle proceeds.
    const receipt = await this.prisma.$queryRawUnsafe(
      `INSERT INTO hivemind.usage_projection_receipts (usage_event_id) VALUES ($1::uuid)
       ON CONFLICT DO NOTHING RETURNING usage_event_id`, event.id,
    );
    if (receipt[0]) await this._applyProjection(orgId, event.metric, Number(event.quantity));
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

  async _applyProjection(orgId, metric, quantity) {
    const entry = Object.entries((await import('./metric-registry.js')).USAGE_METRICS).find(([, value]) => value.metric === metric)?.[1];
    if (!entry) return;
    const month = new Date().toISOString().slice(0, 7);
    const day = new Date().toISOString().slice(0, 10);
    const m = entry.month, d = entry.daily, c = entry.cumulative;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO "OrgUsage" ("orgId", "month", "${m}", "updatedAt") VALUES ($1::uuid, $2, $3, NOW()) ON CONFLICT ("orgId", "month") DO UPDATE SET "${m}" = "OrgUsage"."${m}" + $3, "updatedAt" = NOW()`, orgId, month, quantity);
      await tx.$executeRawUnsafe(`INSERT INTO "OrgUsageDaily" ("orgId", "day", "${d}", "updatedAt") VALUES ($1::uuid, $2::date, $3, NOW()) ON CONFLICT ("orgId", "day") DO UPDATE SET "${d}" = "OrgUsageDaily"."${d}" + $3, "updatedAt" = NOW()`, orgId, day, quantity);
      if (c) await tx.$executeRawUnsafe(`INSERT INTO hivemind.org_usage_cumulative (org_id, "${c}") VALUES ($1::uuid, $2) ON CONFLICT (org_id) DO UPDATE SET "${c}" = hivemind.org_usage_cumulative."${c}" + $2, updated_at = NOW()`, orgId, quantity);
    });
    this.usageTracker?._invalidateCache?.(orgId);
  }
}

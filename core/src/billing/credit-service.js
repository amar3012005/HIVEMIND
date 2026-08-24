import crypto from 'node:crypto';
import { creditCost, publicCreditCatalog } from './credit-catalog.js';

function monthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end, key: start.toISOString().slice(0, 7) };
}

export class CreditService {
  constructor({ prisma, planStore, usageService }) {
    this.prisma = prisma;
    this.planStore = planStore;
    this.usageService = usageService;
  }

  async getSummary(orgId, userId = null, tx = this.prisma) {
    const plan = await this.planStore.getOrgPlan(orgId);
    const included = Number(plan?.limits?.monthlyCredits ?? 0);
    const { start, end, key } = monthWindow();
    const userClause = userId ? ' AND initiating_user_id = $4::uuid' : '';
    const params = userId ? [orgId, start, end, userId] : [orgId, start, end];
    const rows = await tx.$queryRawUnsafe(
      `SELECT state, COALESCE(SUM(quantity),0)::text AS quantity
         FROM hivemind.usage_events
        WHERE org_id=$1::uuid AND metric='credits_consumed'
          AND created_at >= $2::timestamptz AND created_at < $3::timestamptz${userClause}
        GROUP BY state`, ...params,
    );
    const byState = Object.fromEntries(rows.map((r) => [r.state, Number(r.quantity || 0)]));
    const breakdownRows = await tx.$queryRawUnsafe(
      `SELECT COALESCE(metadata->>'service','other') AS service, COALESCE(SUM(quantity),0)::text AS quantity
         FROM hivemind.usage_events
        WHERE org_id=$1::uuid AND metric='credits_consumed' AND state='settled'
          AND created_at >= $2::timestamptz AND created_at < $3::timestamptz${userClause}
        GROUP BY 1 ORDER BY 2 DESC`, ...params,
    );
    const used = byState.settled || 0;
    const reserved = byState.reserved || 0;
    const unlimited = included < 0;
    const remaining = unlimited ? -1 : Math.max(0, included - used - reserved);
    return {
      plan: plan?.id || 'free', included, used, reserved, remaining, unlimited,
      percent_used: unlimited || included === 0 ? 0 : Math.min(100, Math.round(((used + reserved) / included) * 100)),
      percent_remaining: unlimited || included === 0 ? 100 : Math.max(0, 100 - Math.min(100, Math.round(((used + reserved) / included) * 100))),
      period: key, period_start: start.toISOString(), period_end: end.toISOString(), reset_at: end.toISOString(),
      breakdown: Object.fromEntries(breakdownRows.map((r) => [r.service, Number(r.quantity || 0)])),
      catalog: publicCreditCatalog(),
    };
  }

  async reserve({ orgId, userId = null, service, units = 1, source = 'product', idempotencyKey, metadata = {} }) {
    const quantity = creditCost(service, units);
    const key = String(idempotencyKey || crypto.randomUUID()).slice(0, 180);
    if (quantity === 0) return { admitted: true, idempotencyKey: key, quantity: 0 };
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `credits:${orgId}:${monthWindow().key}`);
      const existing = await tx.$queryRawUnsafe(
        `SELECT id,state,quantity,metadata FROM hivemind.usage_events WHERE org_id=$1::uuid AND idempotency_key=$2 LIMIT 1`, orgId, key,
      );
      if (existing[0]) {
        if (Number(existing[0].quantity) !== quantity || existing[0].metadata?.service !== service) throw new Error('credit idempotency key does not match original operation');
        if (existing[0].state === 'released') {
          const summary = await this.getSummary(orgId, null, tx);
          if (!summary.unlimited && quantity > summary.remaining) {
            return { admitted: false, check: { allowed: false, status: 402, reason: 'Monthly credits exhausted', plan: summary.plan, limit: summary.included, current: summary.used + summary.reserved, remaining: summary.remaining } };
          }
          const revived = await tx.$queryRawUnsafe(
            `UPDATE hivemind.usage_events SET state='reserved',released_at=NULL
              WHERE org_id=$1::uuid AND idempotency_key=$2 AND state='released'
              RETURNING id,state,quantity,metadata`, orgId, key,
          );
          return { admitted: true, duplicate: false, revived: true, event: revived[0], idempotencyKey: key, quantity };
        }
        return { admitted: true, duplicate: true, event: existing[0], idempotencyKey: key, quantity };
      }
      const summary = await this.getSummary(orgId, null, tx);
      if (!summary.unlimited && quantity > summary.remaining) {
        return { admitted: false, check: { allowed: false, status: 402, reason: 'Monthly credits exhausted', plan: summary.plan, limit: summary.included, current: summary.used + summary.reserved, remaining: summary.remaining } };
      }
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO hivemind.usage_events (org_id,initiating_user_id,source,metric,quantity,state,idempotency_key,metadata)
         VALUES ($1::uuid,$2::uuid,$3,'credits_consumed',$4::bigint,'reserved',$5,$6::jsonb)
         RETURNING id,state,quantity`, orgId, userId, String(source).slice(0, 80), quantity, key,
        JSON.stringify({ ...metadata, service, units: Math.max(0, Math.ceil(Number(units) || 0)) }),
      );
      return { admitted: true, event: rows[0], idempotencyKey: key, quantity, summary };
    });
  }

  settle(args) { return this.usageService.settle(args); }
  release(args) { return this.usageService.release(args); }
  async adjustReservation({ orgId, idempotencyKey, service, units }) {
    const quantity = creditCost(service, units);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `credits:${orgId}:${monthWindow().key}`);
      const rows = await tx.$queryRawUnsafe(
        `SELECT id,state,quantity,metadata FROM hivemind.usage_events WHERE org_id=$1::uuid AND idempotency_key=$2 FOR UPDATE`, orgId, idempotencyKey,
      );
      const event = rows[0];
      if (!event) throw new Error('credit reservation not found');
      if (event.state === 'settled') return { adjusted: false, duplicate: true, quantity: Number(event.quantity) };
      if (event.state !== 'reserved' || event.metadata?.service !== service) throw new Error('credit reservation is not adjustable');
      const summary = await this.getSummary(orgId, null, tx);
      const available = summary.unlimited ? Number.MAX_SAFE_INTEGER : summary.remaining + Number(event.quantity || 0);
      if (quantity > available) return { adjusted: false, admitted: false, check: { allowed: false, status: 402, reason: 'Monthly credits exhausted', plan: summary.plan, limit: summary.included, current: summary.used + summary.reserved, remaining: summary.remaining } };
      await tx.$executeRawUnsafe(
        `UPDATE hivemind.usage_events SET quantity=$3::bigint,metadata=metadata || $4::jsonb WHERE org_id=$1::uuid AND idempotency_key=$2 AND state='reserved'`,
        orgId, idempotencyKey, quantity, JSON.stringify({ units: Math.max(0, Math.ceil(Number(units) || 0)) }),
      );
      return { adjusted: true, admitted: true, quantity };
    });
  }
  async charge(args) {
    const reserved = await this.reserve(args);
    if (!reserved.admitted) return reserved;
    if (reserved.duplicate && reserved.event?.state !== 'reserved') return reserved;
    return { ...reserved, ...(await this.settle({ orgId: args.orgId, idempotencyKey: reserved.idempotencyKey })) };
  }
}

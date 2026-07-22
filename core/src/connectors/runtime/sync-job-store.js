// Connector Runtime V1 — durable sync job store (plan §7).
//
// Postgres-backed job queue (connector_sync_jobs) — the source of truth that
// replaces the file-backed MCPConnectorJobStore. Lease via SKIP LOCKED so
// multiple workers/replicas can process safely. Prisma injected (raw SQL for
// the lease; the model is also in schema.prisma for typed reads).
//
// The WORKER that leases + runs jobs delegates to the existing canonical
// SyncEngine.runSync (→ ingestSource) — no provider fetch is re-implemented.

import { createHash } from 'node:crypto';

export class SyncJobStore {
  /** @param {{ prisma:any, logger?:any }} deps */
  constructor({ prisma, logger = console }) {
    if (!prisma) throw new Error('SyncJobStore requires prisma');
    this.prisma = prisma;
    this.log = logger;
  }

  static idempotencyKey({ orgId, connectionId, connectorId, mode, key }) {
    return createHash('sha256')
      .update(`${orgId}:${connectionId || ''}:${connectorId}:${mode}:${key || ''}`)
      .digest('hex')
      .slice(0, 64);
  }

  /** Enqueue a job (idempotent on the key). Returns the row (existing or new). */
  async enqueue({ orgId, userId, connectorId, connectionId = null, mode = 'incremental', requestedScope = null, projectIds = [], config = null, key = null }) {
    const idem = SyncJobStore.idempotencyKey({ orgId, connectionId, connectorId, mode, key });
    const existing = await this.prisma.connectorSyncJob.findUnique({ where: { idempotencyKey: idem } }).catch(() => null);
    if (existing && ['queued', 'leased', 'running'].includes(existing.status)) return existing;
    try {
      return await this.prisma.connectorSyncJob.create({
        data: {
          orgId, userId, connectorId, connectionId, mode,
          requestedScope, projectIds, config: config || undefined,
          idempotencyKey: idem, status: 'queued',
        },
      });
    } catch (err) {
      const dup = await this.prisma.connectorSyncJob.findUnique({ where: { idempotencyKey: idem } }).catch(() => null);
      if (dup) return dup;
      throw err;
    }
  }

  /**
   * Lease the next runnable job (queued, or an expired lease) via SKIP LOCKED.
   * Returns the leased row or null. leaseOwner identifies this worker.
   */
  async leaseNext(leaseOwner, { leaseMs = 60_000 } = {}) {
    const rows = await this.prisma.$queryRawUnsafe(
      `UPDATE hivemind.connector_sync_jobs SET status='leased', lease_owner=$1,
         lease_expires_at = NOW() + ($2 || ' milliseconds')::interval,
         started_at = COALESCE(started_at, NOW()), attempt = attempt + 1, updated_at = NOW()
       WHERE id = (
         SELECT id FROM hivemind.connector_sync_jobs
         WHERE (status='queued')
            OR (status IN ('leased','running') AND lease_expires_at < NOW())
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      leaseOwner, String(leaseMs),
    ).catch((e) => { this.log.warn('[sync-job] lease failed:', e?.message); return []; });
    return rows && rows[0] ? rows[0] : null;
  }

  async markRunning(id) {
    return this.prisma.connectorSyncJob.update({ where: { id }, data: { status: 'running', updatedAt: new Date() } }).catch(() => null);
  }

  async complete(id, telemetry = {}) {
    return this.prisma.connectorSyncJob.update({
      where: { id },
      data: {
        status: 'completed', completedAt: new Date(), updatedAt: new Date(),
        processed: telemetry.processed ?? undefined, imported: telemetry.imported ?? undefined,
        skipped: telemetry.skipped ?? undefined, failed: telemetry.failed ?? undefined,
        cursor: telemetry.cursor ?? undefined,
      },
    }).catch(() => null);
  }

  async fail(id, errorMsg, { reauth = false } = {}) {
    const row = await this.prisma.connectorSyncJob.findUnique({ where: { id } }).catch(() => null);
    const status = reauth ? 'reauth_required'
      : (row && row.attempt >= row.maxAttempts ? 'failed' : 'queued'); // retry until maxAttempts
    return this.prisma.connectorSyncJob.update({
      where: { id },
      data: { status, lastError: String(errorMsg || '').slice(0, 1000), leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() },
    }).catch(() => null);
  }

  async requestCancel(id) {
    return this.prisma.connectorSyncJob.update({ where: { id }, data: { cancellationRequestedAt: new Date(), updatedAt: new Date() } }).catch(() => null);
  }
}

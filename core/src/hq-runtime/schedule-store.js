export class HqScheduleStore {
  constructor({ prisma, logger = console }) {
    if (!prisma) throw new Error('HqScheduleStore requires prisma');
    this.prisma = prisma;
    this.logger = logger;
  }

  async leaseNext(leaseOwner, { leaseMs = 120000 } = {}) {
    const rows = await this.prisma.$queryRawUnsafe(
      `UPDATE hivemind.hq_schedules SET status='LEASED',lease_owner=$1,
          lease_expires_at=now()+($2 || ' milliseconds')::interval,
          attempts=attempts+1,updated_at=now()
        WHERE id=(
          SELECT s.id FROM hivemind.hq_schedules s
          JOIN hivemind.hq_runtimes r ON r.id=s.runtime_id AND r.org_id=s.org_id AND r.epoch=s.runtime_epoch
          WHERE s.due_at<=now()
            AND (s.status='PENDING' OR (s.status='LEASED' AND s.lease_expires_at<now()))
            AND r.state NOT IN ('INACTIVE','PAUSED')
            AND NOT EXISTS (
              SELECT 1 FROM hivemind.hq_cycles c
              WHERE c.org_id=s.org_id AND c.status IN ('QUEUED','RUNNING')
                AND (c.lease_expires_at IS NULL OR c.lease_expires_at>now())
            )
          ORDER BY s.due_at ASC FOR UPDATE OF s SKIP LOCKED LIMIT 1
        ) RETURNING *`,
      leaseOwner, String(leaseMs),
    ).catch((error) => { this.logger.warn('[hq-runtime] schedule lease failed:', error.message); return []; });
    return rows[0] || null;
  }

  async complete(id) {
    return this.prisma.hqSchedule.update({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } });
  }

  async fail(id, error) {
    const row = await this.prisma.hqSchedule.findUnique({ where: { id } });
    const terminal = Number(row?.attempts || 0) >= 5;
    return this.prisma.hqSchedule.update({
      where: { id },
      data: {
        status: terminal ? 'FAILED' : 'PENDING',
        dueAt: terminal ? row.dueAt : new Date(Date.now() + Math.min(300000, 15000 * (2 ** Math.max(0, Number(row?.attempts || 1) - 1)))),
        leaseOwner: null, leaseExpiresAt: null, lastError: String(error?.message || error || '').slice(0, 2000),
      },
    });
  }
}

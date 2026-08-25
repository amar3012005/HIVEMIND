/**
 * Audit Logger — records security and compliance events.
 * Only active for Scale and Enterprise plans (checked at call site).
 *
 * Uses the shared Prisma client passed via constructor rather than
 * creating its own connection, so it participates in the same pool
 * as the rest of the server.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_AUDIT_FIELDS = ['userId', 'organizationId', 'resourceId', 'actorApiKeyId', 'sessionId'];

function normalizeUuid(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return UUID_RE.test(normalized) ? normalized : null;
}

function auditData(event = {}) {
  const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? { ...event.metadata }
    : {};
  const rawIdentifiers = {};
  const ids = {};

  for (const field of UUID_AUDIT_FIELDS) {
    const raw = event[field];
    ids[field] = normalizeUuid(raw);
    if (raw != null && !ids[field]) rawIdentifiers[field] = String(raw).slice(0, 1024);
  }
  if (Object.keys(rawIdentifiers).length) {
    metadata.audit_raw_identifiers = {
      ...(metadata.audit_raw_identifiers && typeof metadata.audit_raw_identifiers === 'object'
        ? metadata.audit_raw_identifiers
        : {}),
      ...rawIdentifiers,
    };
  }

  return { ids, metadata };
}

export class AuditLogger {
  constructor(prisma, { logger = console } = {}) {
    this.prisma = prisma;
    this.logger = logger;
    this._enabled = true;
    this._reportedFailures = new Set();
  }

  /**
   * Log an audit event.
   * @param {Object} event
   * @param {string} event.userId - Who performed the action
   * @param {string} [event.organizationId] - Which org
   * @param {string} event.eventType - Short label e.g. "memory.create"
   * @param {string} [event.eventCategory] - auth | data_access | data_modification | system
   * @param {string} event.action - create | read | update | delete | export | erase
   * @param {string} [event.resourceType] - What was acted on (e.g. "memory", "profile", "api_key")
   * @param {string} [event.resourceId] - ID of the resource (UUID)
   * @param {Object} [event.oldValue] - Previous state (for updates/deletes)
   * @param {Object} [event.newValue] - New state (for creates/updates)
   * @param {string} [event.ipAddress] - Client IP
   * @param {string} [event.userAgent] - Client user-agent header
   * @param {string} [event.platformType] - e.g. "mcp", "webapp", "api"
   * @param {string} [event.sessionId] - Session UUID if available
   */
  async log(event) {
    if (!this._enabled || !this.prisma) return;
    try {
      const retentionDays = parseInt(process.env.AUDIT_RETENTION_DAYS || '2555', 10);
      // Prisma maps these fields to UUID columns. Non-UUID identifiers still
      // matter for forensics, but must live in JSON metadata rather than causing
      // an audit write failure (and a noisy warning on every request).
      const { ids, metadata } = auditData(event);
      const created = await this.prisma.auditLog.create({
        select: { id: true, createdAt: true },
        data: {
          userId: ids.userId,
          organizationId: ids.organizationId,
          eventType: event.eventType,
          eventCategory: event.eventCategory || 'system',
          action: event.action || 'read',
          resourceType: event.resourceType || null,
          resourceId: ids.resourceId,
          actorType: event.actorType || 'user',
          actorApiKeyId: ids.actorApiKeyId,
          metadata,
          oldValue: event.oldValue || undefined,
          newValue: event.newValue || undefined,
          ipAddress: event.ipAddress || null,
          userAgent: event.userAgent ? String(event.userAgent).slice(0, 500) : null,
          platformType: event.platformType || null,
          sessionId: ids.sessionId,
          processingBasis: event.processingBasis || null,
          requestId: event.requestId || null,
          retentionUntil: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000),
        },
      });
      // PQC tamper-evidence (FIPS 205 SLH-DSA), hash-chained. Fire-and-forget:
      // SLH-DSA signing is slow, so it must not add latency to the audited
      // request. Chain = sha256(prev_hash + payload), signed.
      this._signAudit(created, { ...event, ...ids });
    } catch (err) {
      // Never let audit logging break the main flow
      const key = `${err?.name || 'Error'}:${err?.code || ''}:${err?.message || ''}`;
      if (!this._reportedFailures.has(key)) {
        this._reportedFailures.add(key);
        this.logger?.warn?.('[audit] Log failed:', err.message);
      }
    }
  }

  async _signAudit(row, event) {
    try {
      const { signAudit, sha256Hex, canonical } = await import('../security/pqc-signer.js');
      const orgId = event.organizationId || null;
      const payload = canonical({
        id: row.id, org: orgId, type: event.eventType, action: event.action || 'read',
        user: event.userId || null, resource: event.resourceId || null,
      });
      // Serialize chain extension per org. read-prev → sign → insert is a
      // read-modify-write: without a lock, two concurrent same-org audits (incl.
      // across the hm-core + hm-core-2 processes, where no in-process mutex helps)
      // read the same tail prev_hash and insert two rows sharing it, forking the
      // chain and causing audit-verify to report a false tamper break. A per-org
      // Postgres advisory lock held for the txn serializes appends; different orgs
      // use different lock keys so they never block each other.
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtext($1))`,
          `audit_chain:${orgId || 'null'}`,
        );
        const prev = await tx.$queryRawUnsafe(
          `SELECT entry_hash FROM audit_signatures WHERE org_id IS NOT DISTINCT FROM $1::uuid ORDER BY seq DESC LIMIT 1`,
          orgId,
        );
        const prevHash = prev?.[0]?.entry_hash || '';
        const entryHash = sha256Hex(prevHash + payload);
        const sig = await signAudit(entryHash);
        if (!sig) return;
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_signatures (audit_id, org_id, alg, prev_hash, entry_hash, signature)
           VALUES ($1::uuid, $2::uuid, 'SLH-DSA-SHA2-128s', $3, $4, $5)
           ON CONFLICT (audit_id) DO NOTHING`,
          row.id, orgId, prevHash, entryHash, sig,
        );
      }, { timeout: 30000 });
    } catch { /* tamper-evidence is best-effort — never affect the request */ }
  }

  /**
   * Write a signed tail checkpoint for one org's audit chain (H5 defense).
   * Anchors (max_seq, head_entry_hash, row_count) under an SLH-DSA signature so
   * audit-verify can detect truncation of the newest entries — which the chain
   * walk alone cannot. Per-org advisory lock keeps it consistent with appends.
   * Returns the checkpoint summary, or null if there is nothing to checkpoint.
   */
  async _writeCheckpoint(orgId) {
    const { signAudit, sha256Hex, canonical } = await import('../security/pqc-signer.js');
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `audit_chain:${orgId || 'null'}`);
      const agg = await tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(seq),0) AS max_seq, COUNT(*) AS cnt
         FROM audit_signatures WHERE org_id IS NOT DISTINCT FROM $1::uuid`, orgId);
      const maxSeq = Number(agg?.[0]?.max_seq || 0);
      const cnt = Number(agg?.[0]?.cnt || 0);
      if (maxSeq === 0) return null; // empty chain — nothing to anchor
      const head = await tx.$queryRawUnsafe(
        `SELECT entry_hash FROM audit_signatures
         WHERE org_id IS NOT DISTINCT FROM $1::uuid AND seq = $2::bigint LIMIT 1`, orgId, maxSeq);
      const headHash = head?.[0]?.entry_hash || '';
      const payload = canonical({ org: orgId, max_seq: maxSeq, head: headHash, count: cnt });
      const sig = await signAudit(sha256Hex(payload));
      if (!sig) return null; // signing disabled (no key) — skip
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_checkpoints (org_id, max_seq, head_entry_hash, row_count, signature)
         VALUES ($1::uuid, $2::bigint, $3, $4::bigint, $5)`,
        orgId, maxSeq, headHash, cnt, sig);
      return { org_id: orgId, max_seq: maxSeq, count: cnt };
    }, { timeout: 30000 });
  }

  /** Checkpoint every org that has audit signatures. Best-effort, never throws. */
  async checkpointAllOrgs() {
    if (!this.prisma) return;
    try {
      const orgs = await this.prisma.$queryRawUnsafe(`SELECT DISTINCT org_id FROM audit_signatures`);
      let n = 0;
      for (const o of orgs || []) {
        try { if (await this._writeCheckpoint(o.org_id)) n++; } catch { /* per-org best-effort */ }
      }
      if (n && String(process.env.RUNTIME_PROGRESS_VERBOSE || '').toLowerCase() === 'true') {
        console.log(`[audit-checkpoint] wrote ${n} checkpoint(s)`);
      }
    } catch (e) { console.warn('[audit-checkpoint] sweep failed:', e.message); }
  }

  /**
   * Query audit logs with filtering and pagination.
   */
  async query({ organizationId, userId, eventCategory, action, resourceType, from, to, limit = 50, offset = 0 }) {
    const where = {};
    if (organizationId) where.organizationId = organizationId;
    if (userId) where.userId = userId;
    if (eventCategory) where.eventCategory = eventCategory;
    if (action) where.action = action;
    if (resourceType) where.resourceType = resourceType;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { logs, total, limit, offset, hasMore: offset + limit < total };
  }
}

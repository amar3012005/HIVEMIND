/**
 * Audit Logger — records security and compliance events.
 * Only active for Scale and Enterprise plans (checked at call site).
 *
 * Uses the shared Prisma client passed via constructor rather than
 * creating its own connection, so it participates in the same pool
 * as the rest of the server.
 */

export class AuditLogger {
  constructor(prisma) {
    this.prisma = prisma;
    this._enabled = true;
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
      await this.prisma.auditLog.create({
        data: {
          userId: event.userId || null,
          organizationId: event.organizationId || null,
          eventType: event.eventType,
          eventCategory: event.eventCategory || 'system',
          action: event.action || 'read',
          resourceType: event.resourceType || null,
          resourceId: event.resourceId || null,
          oldValue: event.oldValue || undefined,
          newValue: event.newValue || undefined,
          ipAddress: event.ipAddress || null,
          userAgent: event.userAgent || null,
          platformType: event.platformType || null,
          sessionId: event.sessionId || null,
        },
      });
    } catch (err) {
      // Never let audit logging break the main flow
      console.warn('[audit] Log failed:', err.message);
    }
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

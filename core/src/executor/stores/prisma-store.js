/**
 * Trail Executor — Prisma Store
 * HIVE-MIND Cognitive Runtime
 *
 * Production persistence layer using Prisma ORM.
 * Implements the same interface as InMemoryStore but backed by PostgreSQL.
 *
 * @module executor/stores/prisma-store
 */

export class PrismaStore {
  constructor(prisma) {
    this.prisma = prisma;
  }

  // ─── Event Methods ──────────────────────────────────────────────────────────

  /** Insert an immutable execution event. */
  async writeEvent(event) {
    await this.prisma.opExecutionEvent.create({
      data: {
        id: event.id,
        trail_id: event.trail_id,
        agent_id: event.agent_id,
        step_index: event.step_index,
        action_name: event.action_name,
        bound_params: event.bound_params || {},
        result: event.result || null,
        error: event.error || null,
        latency_ms: event.latency_ms,
        success: event.success,
        tokens_used: event.tokens_used || null,
        estimated_cost_usd: event.estimated_cost_usd || null,
        routing: event.routing || null,
        timestamp: new Date(event.timestamp),
      },
    });
  }

  /** Return all events for a given trail, ordered by creation time. */
  async getEvents(trailId) {
    const rows = await this.prisma.opExecutionEvent.findMany({
      where: { trail_id: trailId },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((r) => this._mapEventRow(r));
  }

  // ─── Trail Methods ──────────────────────────────────────────────────────────

  /** Append a step summary to an existing trail's steps array. */
  async appendTrailStep(trailId, step) {
    const trail = await this.prisma.opTrail.findUnique({ where: { id: trailId } });
    if (!trail) return;
    const steps = Array.isArray(trail.steps) ? trail.steps : JSON.parse(trail.steps || '[]');
    steps.push(step);
    await this.prisma.opTrail.update({
      where: { id: trailId },
      data: { steps, updated_at: new Date() },
    });
  }

  /** Retrieve a trail by ID. */
  async getTrail(trailId) {
    const row = await this.prisma.opTrail.findUnique({ where: { id: trailId } });
    return row ? this._mapTrailRow(row) : null;
  }

  /** Return all trails matching a given goalId, ordered by weight descending. */
  async getCandidateTrails(goalId) {
    const rows = await this.prisma.opTrail.findMany({
      where: { goal_id: goalId },
      orderBy: { weight: 'desc' },
    });
    return rows.map((r) => this._mapTrailRow(r));
  }

  /** Upsert a trail into the store. */
  async putTrail(trail) {
    await this.prisma.opTrail.upsert({
      where: { id: trail.id },
      create: {
        id: trail.id,
        goal_id: trail.goalId,
        agent_id: trail.agentId || '',
        status: trail.status || 'active',
        next_action: trail.nextAction || null,
        steps: trail.steps || [],
        execution_event_ids: trail.executionEventIds || [],
        success_score: trail.successScore || 0,
        confidence: trail.confidence || 0,
        weight: trail.weight || 0.5,
        decay_rate: trail.decayRate || 0.05,
        tags: trail.tags || [],
      },
      update: {
        goal_id: trail.goalId,
        agent_id: trail.agentId || '',
        status: trail.status || 'active',
        next_action: trail.nextAction || null,
        steps: trail.steps || [],
        execution_event_ids: trail.executionEventIds || [],
        success_score: trail.successScore || 0,
        confidence: trail.confidence || 0,
        weight: trail.weight || 0.5,
        decay_rate: trail.decayRate || 0.05,
        tags: trail.tags || [],
      },
    });
  }

  // ─── Lease Methods (atomic check-and-set) ───────────────────────────────────

  /**
   * Attempt to acquire an exclusive lease for `trailId`.
   * Only succeeds when no unexpired lease exists for the same trail held by a
   * different agent.
   *
   * @param {string} trailId
   * @param {string} agentId
   * @param {number} ttlMs
   * @returns {Promise<{ acquired: boolean, lease: object|null, reason?: string, currentHolder?: string }>}
   */
  async acquireLease(trailId, agentId, ttlMs) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    try {
      const existing = await this.prisma.opTrailLease.findUnique({
        where: { trail_id: trailId },
      });

      if (existing && new Date(existing.expires_at) > now && existing.agent_id !== agentId) {
        return {
          acquired: false,
          lease: null,
          reason: 'already_leased',
          currentHolder: existing.agent_id,
        };
      }

      const lease = await this.prisma.opTrailLease.upsert({
        where: { trail_id: trailId },
        create: {
          trail_id: trailId,
          agent_id: agentId,
          expires_at: expiresAt,
          heartbeat_at: now,
        },
        update: {
          agent_id: agentId,
          expires_at: expiresAt,
          heartbeat_at: now,
          acquired_at: now,
        },
      });

      return {
        acquired: true,
        lease: {
          id: lease.id,
          trailId: lease.trail_id,
          agentId: lease.agent_id,
          acquiredAt: lease.acquired_at.getTime(),
          expiresAt: lease.expires_at.getTime(),
        },
      };
    } catch (err) {
      return { acquired: false, lease: null, reason: 'unknown' };
    }
  }

  /**
   * Renew an existing lease by extending its expiry.
   * @returns {Promise<boolean>} true if renewed, false if not found or expired.
   */
  async renewLease(leaseId, ttlMs) {
    const now = new Date();
    try {
      const lease = await this.prisma.opTrailLease.findUnique({ where: { id: leaseId } });
      if (!lease || new Date(lease.expires_at) < now) return false;
      await this.prisma.opTrailLease.update({
        where: { id: leaseId },
        data: {
          expires_at: new Date(now.getTime() + ttlMs),
          heartbeat_at: now,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Release a lease (idempotent — no error if not found). */
  async releaseLease(leaseId) {
    try {
      await this.prisma.opTrailLease.delete({ where: { id: leaseId } });
    } catch {
      /* idempotent */
    }
  }

  /** Get lease info for a trail (used by TrailSelector for force computation). */
  async getLeaseInfo(trailId) {
    const lease = await this.prisma.opTrailLease.findUnique({
      where: { trail_id: trailId },
    });
    if (!lease || new Date(lease.expires_at) < new Date()) {
      return { leased: false };
    }
    return { leased: true, agentId: lease.agent_id };
  }

  /** Check whether a trail has an active (unexpired) lease. */
  async isLeased(trailId) {
    const info = await this.getLeaseInfo(trailId);
    return info.leased;
  }

  // ─── Weight Methods ──────────────────────────────────────────────────────────

  /** Persist a trail weight along with its component breakdown. */
  async updateTrailWeight(trailId, weight, components) {
    await this.prisma.metaTrailWeight.upsert({
      where: { trail_id: trailId },
      create: {
        trail_id: trailId,
        weight,
        components,
        next_decay_at: new Date(Date.now() + 7 * 86400000),
      },
      update: { weight, components },
    });
    // Also update the trail's weight field
    try {
      await this.prisma.opTrail.update({
        where: { id: trailId },
        data: { weight },
      });
    } catch {
      /* trail may not exist yet */
    }
  }

  /** Retrieve stored weight info for a trail. */
  async getTrailWeight(trailId) {
    return this.prisma.metaTrailWeight.findUnique({ where: { trail_id: trailId } });
  }

  // ─── Promotion Methods ─────────────────────────────────────────────────────

  /** Store a promotion candidate, enforcing dedupe_key uniqueness. */
  async emitPromotionCandidate(candidate) {
    try {
      return await this.prisma.metaPromotionCandidate.create({
        data: {
          id: candidate.id,
          source_event_id: candidate.source_event_id,
          trail_id: candidate.trail_id,
          promotion_rule_id: candidate.promotion_rule_id,
          observations: candidate.observations || [],
          confidence: candidate.confidence,
          status: 'pending',
          dedupe_key: candidate.dedupe_key,
        },
      });
    } catch (err) {
      // Unique constraint violation on dedupe_key = idempotent skip
      if (err.code === 'P2002') return null;
      throw err;
    }
  }

  /** Return promotion candidates, optionally filtered by status. */
  async getPromotionCandidates(status) {
    return this.prisma.metaPromotionCandidate.findMany({
      where: status ? { status } : {},
      orderBy: { created_at: 'asc' },
    });
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  /** Remove all expired leases. */
  async cleanExpired() {
    await this.prisma.opTrailLease.deleteMany({
      where: { expires_at: { lt: new Date() } },
    });
  }

  // ─── Observation Methods ────────────────────────────────────────────────

  /** Write an observation to op_observations. */
  async writeObservation(obs) {
    const row = await this.prisma.opObservation.create({
      data: {
        id: obs.id,
        agent_id: obs.agent_id,
        kind: obs.kind,
        content: obs.content,
        certainty: obs.certainty ?? 0.5,
        source_event_id: obs.source_event_id || null,
        related_to_trail: obs.related_to_trail || null,
      },
    });
    return { id: row.id, kind: row.kind, timestamp: row.timestamp };
  }

  /** List recent observations, optionally filtered by agent. */
  async listObservations({ agentId, kind, limit = 20 } = {}) {
    const rows = await this.prisma.opObservation.findMany({
      where: {
        agent_id: agentId || undefined,
        kind: kind || undefined,
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      agent_id: r.agent_id,
      kind: r.kind,
      content: r.content,
      certainty: r.certainty,
      source_event_id: r.source_event_id,
      related_to_trail: r.related_to_trail,
      timestamp: r.timestamp?.toISOString?.() || r.timestamp,
    }));
  }

  // ─── Row Mappers (snake_case DB → camelCase JS) ──────────────────────────

  _mapTrailRow(row) {
    return {
      id: row.id,
      goalId: row.goal_id,
      agentId: row.agent_id,
      status: row.status,
      nextAction: row.next_action,
      steps: Array.isArray(row.steps) ? row.steps : JSON.parse(row.steps || '[]'),
      executionEventIds: Array.isArray(row.execution_event_ids)
        ? row.execution_event_ids
        : JSON.parse(row.execution_event_ids || '[]'),
      successScore: row.success_score,
      confidence: row.confidence,
      weight: row.weight,
      decayRate: row.decay_rate,
      tags: Array.isArray(row.tags) ? row.tags : JSON.parse(row.tags || '[]'),
      createdAt: row.created_at?.toISOString?.() || row.created_at,
      lastExecutedAt: row.last_executed_at?.toISOString?.() || row.last_executed_at,
    };
  }

  _mapEventRow(row) {
    return {
      id: row.id,
      trail_id: row.trail_id,
      agent_id: row.agent_id,
      step_index: row.step_index,
      action_name: row.action_name,
      bound_params: row.bound_params,
      result: row.result,
      error: row.error,
      latency_ms: row.latency_ms,
      success: row.success,
      tokens_used: row.tokens_used,
      estimated_cost_usd: row.estimated_cost_usd,
      routing: row.routing,
      timestamp: row.timestamp?.toISOString?.() || row.timestamp,
    };
  }
}

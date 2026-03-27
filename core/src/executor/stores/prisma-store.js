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
        kind: trail.kind || 'raw',
        blueprint_meta: trail.blueprintMeta || null,
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
        kind: trail.kind || 'raw',
        blueprint_meta: trail.blueprintMeta || null,
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

  // ─── Chain Run Methods ──────────────────────────────────────────────────

  /** Store a completed chain run summary for blueprint mining (as an observation). */
  async storeChainRun(run) {
    await this.prisma.opObservation.create({
      data: {
        agent_id: run.agentId || 'system',
        kind: 'chain_run',
        content: {
          goalId: run.goalId,
          toolSequence: run.toolSequence,
          successRate: run.successRate,
          doneReason: run.doneReason,
          totalLatencyMs: run.totalLatencyMs,
        },
        certainty: run.successRate ?? 1.0,
        related_to_trail: run.trailId || null,
      },
    });
  }

  /** Get chain runs for a goal from stored observations. */
  async getChainRuns(goalId, limit = 50) {
    const rows = await this.prisma.opObservation.findMany({
      where: { kind: 'chain_run' },
      orderBy: { timestamp: 'desc' },
      take: limit * 3, // over-fetch to filter by goalId in content
    });

    return rows
      .map(r => {
        const c = r.content;
        return c?.goalId === goalId ? {
          goalId: c.goalId,
          toolSequence: c.toolSequence,
          successRate: c.successRate,
          doneReason: c.doneReason,
          totalLatencyMs: c.totalLatencyMs,
        } : null;
      })
      .filter(Boolean)
      .slice(0, limit);
  }

  // ─── Agent Methods ──────────────────────────────────────────────────────────

  async ensureAgent(agentId, defaults = {}) {
    const existing = await this.prisma.opAgent.findFirst({ where: { agent_id: agentId } });
    if (existing) return this._mapAgentRow(existing);
    const created = await this.prisma.opAgent.create({
      data: {
        agent_id: agentId,
        role: defaults.role || 'generalist',
        model_version: defaults.model || '',
        skills: defaults.skills || [],
        status: 'active',
        source: defaults.source || 'implicit',
      },
    });
    return this._mapAgentRow(created);
  }

  async getAgent(agentId) {
    const row = await this.prisma.opAgent.findFirst({ where: { agent_id: agentId } });
    return row ? this._mapAgentRow(row) : null;
  }

  async listAgents(filters = {}) {
    const where = {};
    if (filters.role) where.role = filters.role;
    if (filters.status) where.status = filters.status;
    if (filters.source) where.source = filters.source;
    const rows = await this.prisma.opAgent.findMany({ where, orderBy: { created_at: 'desc' } });
    return rows.map(r => this._mapAgentRow(r));
  }

  async updateAgent(agentId, updates) {
    const data = {};
    if (updates.role) data.role = updates.role;
    if (updates.skills) data.skills = updates.skills;
    if (updates.status) data.status = updates.status;
    if (updates.model_version) data.model_version = updates.model_version;
    try {
      const row = await this.prisma.opAgent.update({ where: { agent_id: agentId }, data });
      return this._mapAgentRow(row);
    } catch { return null; }
  }

  async updateAgentLastSeen(agentId) {
    try {
      await this.prisma.opAgent.update({ where: { agent_id: agentId }, data: { last_seen_at: new Date() } });
    } catch { /* agent may not exist */ }
  }

  _mapAgentRow(row) {
    return {
      id: row.id,
      agent_id: row.agent_id,
      role: row.role,
      model_version: row.model_version,
      skills: Array.isArray(row.skills) ? row.skills : JSON.parse(row.skills || '[]'),
      status: row.status,
      source: row.source || 'implicit',
      last_seen_at: row.last_seen_at?.toISOString?.() || row.last_seen_at,
      created_at: row.created_at?.toISOString?.() || row.created_at,
      updated_at: row.updated_at?.toISOString?.() || row.updated_at,
    };
  }

  // ─── Reputation Methods (enhanced) ──────────────────────────────────────────

  async getReputation(agentId) {
    const row = await this.prisma.metaReputation.findUnique({ where: { agent_id: agentId } });
    if (!row) return null;
    const scores = row.skill_scores || {};
    return {
      agent_id: row.agent_id,
      success_rate: row.success_rate,
      avg_confidence: row.avg_confidence,
      skill_scores: scores.skill_scores || scores,
      blueprint_scores: scores.blueprint_scores || {},
      specialization_confidence: scores.specialization_confidence || { explorer: 0, operator: 0, evaluator: 0 },
      recent_attempts: row.recent_attempts,
      updated_at: row.updated_at?.toISOString?.() || row.updated_at,
    };
  }

  async updateReputation(agentId, rep) {
    const skillScoresPayload = {
      skill_scores: rep.skill_scores || {},
      blueprint_scores: rep.blueprint_scores || {},
      specialization_confidence: rep.specialization_confidence || {},
    };
    await this.prisma.metaReputation.upsert({
      where: { agent_id: agentId },
      create: {
        agent_id: agentId,
        success_rate: rep.success_rate ?? 0.5,
        avg_confidence: rep.avg_confidence ?? 0.5,
        skill_scores: skillScoresPayload,
        recent_attempts: rep.recent_attempts ?? 0,
      },
      update: {
        success_rate: rep.success_rate ?? 0.5,
        avg_confidence: rep.avg_confidence ?? 0.5,
        skill_scores: skillScoresPayload,
        recent_attempts: rep.recent_attempts ?? 0,
      },
    });
  }

  // ─── Parameter Methods ────────────────────────────────────────────────────

  async getParameter(key) {
    const row = await this.prisma.metaParameter.findUnique({ where: { key } });
    return row || null;
  }

  async getAllParameters() {
    const rows = await this.prisma.metaParameter.findMany();
    const result = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  async setParameter(key, value, updatedBy = 'system') {
    const existing = await this.prisma.metaParameter.findUnique({ where: { key } });
    await this.prisma.metaParameter.upsert({
      where: { key },
      create: { key, value, updated_by: updatedBy },
      update: { value, previous_value: existing?.value ?? null, updated_by: updatedBy },
    });
  }

  async rollbackParameter(key) {
    const existing = await this.prisma.metaParameter.findUnique({ where: { key } });
    if (!existing || existing.previous_value === null) return null;
    const rolledBack = { from: existing.value, to: existing.previous_value };
    await this.prisma.metaParameter.update({
      where: { key },
      data: { value: existing.previous_value, previous_value: null, updated_by: 'rollback' },
    });
    return rolledBack;
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
      kind: row.kind || 'raw',
      blueprintMeta: row.blueprint_meta || null,
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

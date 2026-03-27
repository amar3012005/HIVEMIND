/**
 * Trail Executor — In-Memory Store
 * HIVE-MIND Cognitive Runtime
 *
 * Map-based implementation of the executor store interface.
 * Designed for testing; production uses PrismaStore with the same interface.
 *
 * @module executor/stores/in-memory-store
 */

import { randomUUID } from 'node:crypto';

export class InMemoryStore {
  constructor() {
    /** @type {import('../types/event.types.js').ExecutionEvent[]} */
    this.events = [];
    /** @type {Map<string, import('../types/trail.types.js').Trail>} */
    this.trails = new Map();
    /** @type {Map<string, import('../types/lease.types.js').TrailLease>} */
    this.leases = new Map(); // keyed by trailId
    /** @type {Map<string, { trail_id: string, weight: number, components: Object, updated_at: string }>} */
    this.trailWeights = new Map();
    /** @type {Array<Object>} */
    this.promotionCandidates = [];
  }

  // ─── Event Methods ──────────────────────────────────────────────────────────

  /** Append an immutable execution event. */
  async writeEvent(event) {
    this.events.push(Object.freeze({ ...event }));
  }

  /** Return all events for a given trail, ordered by insertion. */
  async getEvents(trailId) {
    return this.events.filter((e) => e.trail_id === trailId);
  }

  // ─── Trail Methods ──────────────────────────────────────────────────────────

  /** Append a step summary to an existing trail's steps array. */
  async appendTrailStep(trailId, step) {
    const trail = this.trails.get(trailId);
    if (!trail) return;
    trail.steps.push(step);
    trail.updatedAt = Date.now();
  }

  /** Retrieve a trail by ID. */
  async getTrail(trailId) {
    const trail = this.trails.get(trailId) ?? null;
    if (trail && !trail.kind) trail.kind = 'raw';
    return trail;
  }

  /** Return all trails matching a given goalId. */
  async getCandidateTrails(goalId) {
    return [...this.trails.values()].filter((t) => t.goalId === goalId);
  }

  /** Seed a trail into the store (test helper). */
  async putTrail(trail) {
    this.trails.set(trail.id, { kind: 'raw', blueprintMeta: null, ...trail });
  }

  // ─── Lease Methods (atomic check-and-set) ───────────────────────────────────

  /**
   * Attempt to acquire an exclusive lease for `trailId`.
   * Implements a compare-and-swap: only succeeds when no unexpired lease exists
   * for the same trail held by a different agent.
   *
   * @param {string} trailId
   * @param {string} agentId
   * @param {number} ttlMs
   * @returns {Promise<import('../types/lease.types.js').LeaseAcquireResult>}
   */
  async acquireLease(trailId, agentId, ttlMs) {
    const now = Date.now();
    const existing = this.leases.get(trailId);

    if (existing && existing.expiresAt > now && existing.agentId !== agentId) {
      return {
        acquired: false,
        lease: null,
        reason: 'already_leased',
        currentHolder: existing.agentId,
      };
    }

    const lease = {
      id: randomUUID(),
      trailId,
      agentId,
      acquiredAt: now,
      expiresAt: now + ttlMs,
      ttlMs,
      released: false,
    };

    this.leases.set(trailId, lease);
    return { acquired: true, lease };
  }

  /**
   * Renew an existing lease by extending its expiry.
   * @returns {Promise<boolean>} true if renewed, false if not found or expired.
   */
  async renewLease(leaseId, ttlMs) {
    const now = Date.now();
    for (const [, lease] of this.leases) {
      if (lease.id === leaseId) {
        if (lease.expiresAt < now) return false;
        lease.expiresAt = now + ttlMs;
        lease.heartbeatAt = now;
        return true;
      }
    }
    return false;
  }

  /** Release a lease (idempotent — no error if not found). */
  async releaseLease(leaseId) {
    for (const [trailId, lease] of this.leases) {
      if (lease.id === leaseId) {
        this.leases.delete(trailId);
        return;
      }
    }
  }

  /** Get lease info for a trail (used by TrailSelector for force computation). */
  async getLeaseInfo(trailId) {
    const lease = this.leases.get(trailId);
    if (!lease || lease.expiresAt < Date.now()) {
      return { leased: false };
    }
    return { leased: true, agentId: lease.agentId };
  }

  /** Check whether a trail has an active (unexpired) lease. */
  async isLeased(trailId) {
    const lease = this.leases.get(trailId);
    if (!lease) return false;
    if (lease.expiresAt < Date.now()) {
      this.leases.delete(trailId);
      return false;
    }
    return true;
  }

  // ─── Weight Methods ──────────────────────────────────────────────────────────

  /** Persist a trail weight along with its component breakdown. */
  async updateTrailWeight(trailId, weight, components) {
    this.trailWeights.set(trailId, {
      trail_id: trailId,
      weight,
      components,
      updated_at: new Date().toISOString(),
    });
    const trail = this.trails.get(trailId);
    if (trail) trail.weight = weight;
  }

  /** Retrieve stored weight info for a trail. */
  async getTrailWeight(trailId) {
    return this.trailWeights.get(trailId) ?? null;
  }

  // ─── Promotion Methods ─────────────────────────────────────────────────────

  /** Store a promotion candidate, enforcing dedupe_key uniqueness. */
  async emitPromotionCandidate(candidate) {
    const existing = this.promotionCandidates.find(
      (c) => c.dedupe_key === candidate.dedupe_key,
    );
    if (existing) return null;
    this.promotionCandidates.push(candidate);
    return candidate;
  }

  /** Return promotion candidates, optionally filtered by status. */
  async getPromotionCandidates(status) {
    return this.promotionCandidates.filter((c) => !status || c.status === status);
  }

  /** Remove all expired leases. */
  async cleanExpired() {
    const now = Date.now();
    for (const [trailId, lease] of this.leases) {
      if (lease.expiresAt < now) {
        this.leases.delete(trailId);
      }
    }
  }
}

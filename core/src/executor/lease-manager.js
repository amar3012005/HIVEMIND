/**
 * Trail Executor — Lease Manager
 * HIVE-MIND Cognitive Runtime
 *
 * Prevents concurrent execution of the same trail by managing
 * exclusive, time-bounded leases with heartbeat renewal.
 *
 * @module executor/lease-manager
 */

/** @typedef {import('./types/lease.types.js').TrailLease} TrailLease */
/** @typedef {import('./types/lease.types.js').LeaseAcquireResult} LeaseAcquireResult */

export class LeaseManager {
  /**
   * @param {object} store - Object implementing { acquireLease, renewLease, releaseLease, isLeased, cleanExpired }
   */
  constructor(store) {
    this.store = store;
  }

  /**
   * Attempt to acquire an exclusive lease for the given trail.
   *
   * For in-memory store: simple check-and-set.
   * For Prisma store: should use SELECT FOR UPDATE for atomicity.
   *
   * @param {string} trailId
   * @param {string} agentId
   * @param {number} ttlMs - Lease duration in milliseconds
   * @returns {Promise<LeaseAcquireResult>}
   */
  async acquire(trailId, agentId, ttlMs) {
    return this.store.acquireLease(trailId, agentId, ttlMs);
  }

  /**
   * Renew an active lease by extending its TTL.
   *
   * @param {string} leaseId
   * @param {number} ttlMs - New TTL from now
   * @returns {Promise<boolean>} true if renewed, false if not found or expired
   */
  async renew(leaseId, ttlMs) {
    return this.store.renewLease(leaseId, ttlMs);
  }

  /**
   * Release a lease. Idempotent — no error if the lease does not exist.
   *
   * @param {string} leaseId
   * @returns {Promise<void>}
   */
  async release(leaseId) {
    return this.store.releaseLease(leaseId);
  }

  /**
   * Get lease info for a trail (used by TrailSelector for force computation).
   *
   * @param {string} trailId
   * @returns {Promise<{ leased: boolean, agentId?: string }>}
   */
  async getLeaseInfo(trailId) {
    if (this.store.getLeaseInfo) {
      return this.store.getLeaseInfo(trailId);
    }
    // Fallback: use isLeased
    const leased = await this.store.isLeased(trailId);
    return { leased };
  }

  /**
   * Check whether a trail currently has an active (unexpired) lease.
   *
   * @param {string} trailId
   * @returns {Promise<boolean>}
   */
  async isLeased(trailId) {
    return this.store.isLeased(trailId);
  }

  /**
   * Remove all expired leases. Called periodically or on access.
   *
   * @returns {Promise<void>}
   */
  async cleanExpired() {
    return this.store.cleanExpired();
  }
}

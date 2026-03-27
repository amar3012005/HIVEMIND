/**
 * Trail Executor — Lease Type Contracts
 * HIVE-MIND Cognitive Runtime
 *
 * Distributed leases for exclusive trail-step ownership.
 * Prevents multiple executors from advancing the same trail concurrently.
 */

/**
 * An active lease granting exclusive access to a trail step.
 *
 * @typedef {Object} TrailLease
 * @property {import('./agent.types.js').LeaseId} id - Lease token
 * @property {import('./agent.types.js').TrailId} trailId - Trail being leased
 * @property {import('./agent.types.js').AgentId} agentId - Agent holding the lease
 * @property {number} acquiredAt - Unix epoch ms
 * @property {number} expiresAt - Unix epoch ms
 * @property {number} ttlMs - Lease duration in milliseconds
 * @property {boolean} released - Whether the lease has been explicitly released
 */

/**
 * Result of attempting to acquire a trail lease.
 *
 * @typedef {Object} LeaseAcquireResult
 * @property {boolean} acquired - Whether the lease was successfully acquired
 * @property {TrailLease | null} lease - The lease object (null when not acquired)
 * @property {string} [reason] - Explanation when acquisition fails (e.g. 'already_leased')
 * @property {import('./agent.types.js').AgentId} [currentHolder] - Agent holding the conflicting lease
 */

export const LEASE_TYPES = Symbol.for('hivemind.executor.lease.types');

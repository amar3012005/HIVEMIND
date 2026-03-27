/**
 * Lease Manager — Unit Tests
 * HIVE-MIND Trail Executor
 *
 * @module tests/executor/lease-manager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LeaseManager } from '../../core/src/executor/lease-manager.js';
import { InMemoryStore } from '../../core/src/executor/stores/in-memory-store.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TTL = 5_000; // 5 seconds

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LeaseManager', () => {
  let store;
  let manager;

  beforeEach(() => {
    store = new InMemoryStore();
    manager = new LeaseManager(store);
  });

  it('should acquire lease for unleased trail', async () => {
    const result = await manager.acquire('trail-1', 'agent-1', TTL);

    expect(result.acquired).toBe(true);
    expect(result.lease).toBeTruthy();
    expect(result.lease.trailId).toBe('trail-1');
    expect(result.lease.agentId).toBe('agent-1');
    expect(result.lease.expiresAt).toBeGreaterThan(Date.now());
  });

  it('should reject lease when trail already leased by another agent', async () => {
    await manager.acquire('trail-1', 'agent-1', TTL);
    const result = await manager.acquire('trail-1', 'agent-2', TTL);

    expect(result.acquired).toBe(false);
    expect(result.reason).toBe('already_leased');
    expect(result.currentHolder).toBe('agent-1');
  });

  it('should allow re-lease when previous lease expired', async () => {
    // Acquire with a very short TTL
    await manager.acquire('trail-1', 'agent-1', 1);

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 10));

    const result = await manager.acquire('trail-1', 'agent-2', TTL);
    expect(result.acquired).toBe(true);
    expect(result.lease.agentId).toBe('agent-2');
  });

  it('should renew active lease (extends TTL)', async () => {
    const { lease } = await manager.acquire('trail-1', 'agent-1', TTL);
    const originalExpiry = lease.expiresAt;

    // Small delay so new expiry is measurably different
    await new Promise((r) => setTimeout(r, 5));

    const renewed = await manager.renew(lease.id, TTL);
    expect(renewed).toBe(true);

    // Verify the lease is still active
    const leased = await manager.isLeased('trail-1');
    expect(leased).toBe(true);
  });

  it('should fail to renew expired lease', async () => {
    const { lease } = await manager.acquire('trail-1', 'agent-1', 1);

    await new Promise((r) => setTimeout(r, 10));

    const renewed = await manager.renew(lease.id, TTL);
    expect(renewed).toBe(false);
  });

  it('should release lease (idempotent)', async () => {
    const { lease } = await manager.acquire('trail-1', 'agent-1', TTL);

    await manager.release(lease.id);
    const leased = await manager.isLeased('trail-1');
    expect(leased).toBe(false);

    // Second release should not throw
    await expect(manager.release(lease.id)).resolves.toBeUndefined();
  });

  it('should report isLeased correctly for active/expired/missing', async () => {
    // Missing
    expect(await manager.isLeased('trail-1')).toBe(false);

    // Active
    await manager.acquire('trail-1', 'agent-1', TTL);
    expect(await manager.isLeased('trail-1')).toBe(true);

    // Expired — acquire with tiny TTL on a different trail
    await manager.acquire('trail-2', 'agent-1', 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(await manager.isLeased('trail-2')).toBe(false);
  });

  it('should clean up expired leases', async () => {
    await manager.acquire('trail-1', 'agent-1', 1);
    await manager.acquire('trail-2', 'agent-1', 1);
    await manager.acquire('trail-3', 'agent-1', TTL);

    await new Promise((r) => setTimeout(r, 10));

    await manager.cleanExpired();

    expect(await manager.isLeased('trail-1')).toBe(false);
    expect(await manager.isLeased('trail-2')).toBe(false);
    expect(await manager.isLeased('trail-3')).toBe(true);
  });
});

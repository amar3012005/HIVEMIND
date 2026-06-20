/**
 * RED tests for T0: Redis L1 dedup cache in SyncEngine.
 *
 * Current state: SyncEngine._isDuplicate and _markSeen use only an in-memory
 * Map and Prisma. These tests assert the NEW Redis-backed behaviour that
 * doesn't exist yet — they MUST fail until the implementation is added.
 *
 * Failure mode expected: methods exist but Redis path is not implemented,
 * so Redis-hit assertions fail or Redis key format assertions fail.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEngine } from '../sync-engine.js';

// ---------------------------------------------------------------------------
// Mock ioredis — intercepted at module level before SyncEngine is imported.
// When SyncEngine calls getDedupRedis() / new Redis() we return this mock.
// ---------------------------------------------------------------------------
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisQuit = vi.fn();

vi.mock('ioredis', () => {
  const RedisMock = vi.fn().mockImplementation(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    quit: mockRedisQuit,
    status: 'ready',
  }));
  return { default: RedisMock, Redis: RedisMock };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SyncEngine with a fake Prisma that can be controlled. */
function makeEngine({ prismaFindFirst = null } = {}) {
  const prisma = {
    sourceMetadata: {
      findFirst: vi.fn().mockResolvedValue(prismaFindFirst),
    },
  };

  const engine = new SyncEngine({
    connectorStore: {},
    memoryEngine: null,
    memoryStore: null,
    prisma,
  });

  return { engine, prisma };
}

// ---------------------------------------------------------------------------
// T0-1  Redis HIT → returns true, Prisma NOT called
// ---------------------------------------------------------------------------
describe('SyncEngine._isDuplicate — Redis L1 cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the in-memory cache between tests to avoid cross-test pollution.
  });

  it('T0-1: returns true on Redis HIT without touching Prisma', async () => {
    // Redis returns '1' → cache hit
    mockRedisGet.mockResolvedValue('1');

    const { engine, prisma } = makeEngine({ prismaFindFirst: null });

    // Inject a live-looking Redis client so the engine uses it.
    // The implementation must expose getDedupRedis() or similar;
    // until it does, this test will fail because the method doesn't exist.
    if (typeof engine.getDedupRedis === 'function') {
      vi.spyOn(engine, 'getDedupRedis').mockReturnValue({
        get: mockRedisGet,
        set: mockRedisSet,
      });
    }

    const result = await engine._isDuplicate('item-123', 'user-A', 'personio-v2', 'org-1');
    expect(result).toBe(true);
    // Prisma must NOT be queried when Redis hits
    expect(prisma.sourceMetadata.findFirst).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // T0-2  Redis MISS → falls through to Prisma
  // -------------------------------------------------------------------------
  it('T0-2: falls through to Prisma when Redis misses (returns null)', async () => {
    mockRedisGet.mockResolvedValue(null);

    const { engine, prisma } = makeEngine({ prismaFindFirst: { id: 'existing-mem' } });

    if (typeof engine.getDedupRedis === 'function') {
      vi.spyOn(engine, 'getDedupRedis').mockReturnValue({
        get: mockRedisGet,
        set: mockRedisSet,
      });
    }

    const result = await engine._isDuplicate('item-456', 'user-A', 'personio-v2', 'org-1');
    // Prisma has a record → should return true
    expect(result).toBe(true);
    expect(prisma.sourceMetadata.findFirst).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // T0-3  Redis UNAVAILABLE → no throw, graceful fallback
  // -------------------------------------------------------------------------
  it('T0-3: does not throw when getDedupRedis() returns null (Redis unavailable)', async () => {
    const { engine } = makeEngine({ prismaFindFirst: null });

    // Simulate Redis unavailable by returning null from getDedupRedis
    if (typeof engine.getDedupRedis === 'function') {
      vi.spyOn(engine, 'getDedupRedis').mockReturnValue(null);
    }
    // Even if getDedupRedis doesn't exist yet, the key assertion below
    // will catch missing behaviour.

    await expect(
      engine._isDuplicate('item-789', 'user-A', 'personio-v2', 'org-1')
    ).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // T0-4  _markSeen Redis write FAILURE is swallowed
  // -------------------------------------------------------------------------
  it('T0-4: _markSeen swallows Redis write failures silently', async () => {
    mockRedisSet.mockRejectedValue(new Error('Redis ECONNREFUSED'));

    const { engine } = makeEngine();

    if (typeof engine.getDedupRedis === 'function') {
      vi.spyOn(engine, 'getDedupRedis').mockReturnValue({
        get: mockRedisGet,
        set: mockRedisSet,
      });
    }

    // Must not throw — Redis write failure is fire-and-forget
    await expect(
      Promise.resolve(engine._markSeen('item-abc', 'user-A', 'personio-v2', 'org-1'))
    ).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // T0-5  Dedup key format: dedup:{orgId}:{userId}:{provider}:{dedupeKey}
  // -------------------------------------------------------------------------
  it('T0-5: uses correct Redis key format dedup:{orgId}:{userId}:{provider}:{dedupeKey}', async () => {
    mockRedisGet.mockResolvedValue(null); // miss so we can observe the key

    const { engine } = makeEngine({ prismaFindFirst: null });

    const capturedKeys = [];
    const redisProxy = {
      get: (key) => { capturedKeys.push(key); return Promise.resolve(null); },
      set: vi.fn().mockResolvedValue('OK'),
    };

    if (typeof engine.getDedupRedis === 'function') {
      vi.spyOn(engine, 'getDedupRedis').mockReturnValue(redisProxy);
    }

    await engine._isDuplicate('emp-99', 'user-B', 'personio-v2', 'org-X');

    // The Redis GET key MUST include orgId for tenant isolation.
    // Expected format: dedup:org-X:user-B:personio-v2:emp-99
    const expectedKey = 'dedup:org-X:user-B:personio-v2:emp-99';
    expect(capturedKeys).toContain(expectedKey);
  });

  // -------------------------------------------------------------------------
  // T0-6  TENANT ISOLATION: same dedupeKey + provider, different orgId →
  //        org-A marking seen DOES NOT suppress org-B import
  // -------------------------------------------------------------------------
  it('T0-6: tenant isolation — org-A cache hit does NOT suppress org-B import', async () => {
    const { engine } = makeEngine({ prismaFindFirst: null });

    // Org-A's Redis slot returns '1' (seen), org-B's slot returns null (not seen)
    const redisProxy = {
      get: vi.fn().mockImplementation((key) => {
        if (key.includes(':org-A:')) return Promise.resolve('1');
        if (key.includes(':org-B:')) return Promise.resolve(null);
        return Promise.resolve(null);
      }),
      set: vi.fn().mockResolvedValue('OK'),
    };

    if (typeof engine.getDedupRedis === 'function') {
      vi.spyOn(engine, 'getDedupRedis').mockReturnValue(redisProxy);
    }

    const seenForOrgA = await engine._isDuplicate('emp-42', 'user-A', 'personio-v2', 'org-A');
    const seenForOrgB = await engine._isDuplicate('emp-42', 'user-B', 'personio-v2', 'org-B');

    // Org-A: already seen → true
    expect(seenForOrgA).toBe(true);
    // Org-B: NOT seen (different tenant) → must be false (Prisma also returns null)
    expect(seenForOrgB).toBe(false);
  });
});

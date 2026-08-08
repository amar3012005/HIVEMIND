import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProjectionCacheKey, ChatProjectionCache } from '../../src/agent/chat-cag-cache.js';

test('projection cache key is tenant scoped and changes when ranked content changes', () => {
  const base = {
    orgId: 'org-a', userId: 'user-a', projectIds: ['project-a'], scope: 'personal',
    query: 'handbag color', budget: 6000,
    memories: [{ id: 'm1', content: 'dark brown' }],
  };
  const same = buildProjectionCacheKey(base);
  assert.equal(same, buildProjectionCacheKey({ ...base }));
  assert.notEqual(same, buildProjectionCacheKey({ ...base, userId: 'user-b' }));
  assert.notEqual(same, buildProjectionCacheKey({ ...base, memories: [{ id: 'm1', content: 'black' }] }));
  assert.notEqual(same, buildProjectionCacheKey({ ...base, contextRevision: 2 }));
  assert.notEqual(same, buildProjectionCacheKey({ ...base, projectorVersion: 'adaptive-v3' }));
  assert.notEqual(same, buildProjectionCacheKey({ ...base, memories: [{ id: 'm1', content: 'dark brown', tags: ['changed'] }] }));
});

test('projection cache returns only a live entry for the exact key', async () => {
  const cache = new ChatProjectionCache({ ttlMs: 1000 });
  await cache.set('key-a', [{ excerpt: 'dark brown' }]);
  assert.deepEqual(await cache.get('key-a'), [{ excerpt: 'dark brown' }]);
  assert.equal(await cache.get('key-b'), null);
});

test('projection cache backfills its local tier from Redis without trusting another key', async () => {
  const values = new Map();
  const redis = {
    async get(key) { return values.get(key) || null; },
    async set(key, value, mode, ttl) {
      assert.equal(mode, 'EX');
      assert.equal(ttl, 2);
      values.set(key, value);
    },
  };
  const writer = new ChatProjectionCache({ ttlMs: 2000, redisClient: redis });
  await writer.set('key-a', [{ excerpt: 'brand: G ROCHER' }]);

  const reader = new ChatProjectionCache({ ttlMs: 2000, redisClient: redis });
  assert.deepEqual(await reader.get('key-a'), [{ excerpt: 'brand: G ROCHER' }]);
  assert.equal(await reader.get('key-b'), null);
});

/**
 * Regression: usage, limit, metric, export and list reads must never select the
 * large jsonb columns of web_intel_jobs (Core heap exhaustion in JSON.parse).
 */
import { describe, it, expect } from 'vitest';
import { WebJobStore } from '../../src/web/web-job-store.js';

const HEAVY = ['result', 'progress', 'providerAttempts'];
const BIG = 'x'.repeat(1_600_000);

function fakePrisma(jobs) {
  const selects = [];
  const pick = (row, select) => {
    if (!select) return { ...row };
    const out = {};
    for (const key of Object.keys(select)) if (select[key]) out[key] = row[key];
    return out;
  };
  return {
    selects,
    webIntelUsageSettlement: { findMany: async () => jobs.map((job) => ({ jobId: job.id })) },
    webIntelJob: {
      findMany: async ({ where = {}, select, take }) => {
        selects.push(select || null);
        let rows = jobs.filter((job) => (!where.id?.in || where.id.in.includes(job.id))
          && (!where.status || job.status === where.status) && (!where.orgId || job.orgId === where.orgId)
          && (!where.userId || job.userId === where.userId)
          && (!where.createdAt?.gte || job.createdAt >= where.createdAt.gte));
        if (take) rows = rows.slice(0, take);
        return rows.map((row) => pick(row, select));
      },
    },
  };
}

const now = new Date();
const job = (id, type, extra = {}) => ({ id, type, status: 'succeeded', userId: 'u', orgId: 'o', createdAt: now, updatedAt: now,
  pagesProcessed: type === 'crawl' ? 7 : 0, durationMs: 100, runtimeUsed: 'x', errorMessage: null,
  request: { q: id }, result: { text: BIG }, progress: [{ text: BIG }], providerAttempts: [{ text: BIG }], ...extra });

describe('WebJobStore memory bounds', () => {
  const jobs = [job('a', 'search'), job('b', 'research'), job('c', 'crawl'), job('old', 'search', { createdAt: new Date('2020-01-01') })];

  it('usage, monthly, limits, metrics and export never select jsonb outputs', async () => {
    const prisma = fakePrisma(jobs);
    const store = new WebJobStore({ prisma });
    expect(await store.getUsage({ userId: 'u', orgId: 'o' })).toEqual({ web_search_requests: 2, web_crawl_pages: 7 });
    expect((await store.getMonthlyUsage({ userId: 'u', orgId: 'o' })).web_search_requests.used).toBe(2);
    const limits = await store.checkLimits({ userId: 'u', orgId: 'o' });
    expect(limits.daily.search.used).toBe(2);
    expect(limits.monthly.crawl.used).toBe(7);
    expect((await store.getMetrics('o')).total_jobs).toBe(4);
    expect((await store.exportUsage({ userId: 'u', orgId: 'o' })).length).toBe(2);
    expect(prisma.selects.length).toBeGreaterThan(0);
    for (const select of prisma.selects) {
      expect(select).toBeTruthy();
      for (const column of HEAVY) expect(select[column]).toBeFalsy();
    }
  });

  it('checkLimits reads settled jobs once', async () => {
    const prisma = fakePrisma(jobs);
    await new WebJobStore({ prisma }).checkLimits({ userId: 'u', orgId: 'o' });
    expect(prisma.selects.length).toBe(1);
  });

  it('list omits result, progress and provider attempts', async () => {
    const prisma = fakePrisma(jobs);
    const listed = await new WebJobStore({ prisma }).list({ userId: 'u', orgId: 'o' }, { limit: 10 });
    expect(listed.length).toBe(4);
    for (const row of listed) { expect(row.results).toBeNull(); expect(row.progress).toEqual([]); expect(row.provider_attempts).toEqual([]); expect(row.params).toBeTruthy(); }
  });
});

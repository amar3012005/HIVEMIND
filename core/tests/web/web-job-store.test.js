/**
 * Smoke tests for web-job-store.js
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { WebJobStore } from '../../src/web/web-job-store.js';

const TEST_FILE = path.join(process.cwd(), 'data', 'test-web-jobs.json');

describe('WebJobStore', () => {
  let store;

  beforeEach(() => {
    store = new WebJobStore(TEST_FILE);
  });

  afterEach(() => {
    try { fs.unlinkSync(TEST_FILE); } catch {}
  });

  it('creates a job', async () => {
    const job = await store.create({ type: 'search', params: { query: 'test' }, userId: 'u1', orgId: 'o1' });
    expect(job.id).toBeTruthy();
    expect(job.status).toBe('queued');
    expect(job.type).toBe('search');
  });

  it('updates a job', async () => {
    const job = await store.create({ type: 'crawl', params: { urls: ['https://x.com'] }, userId: 'u1', orgId: 'o1' });
    await store.update(job.id, { status: 'running' });
    const updated = await store.get(job.id, { userId: 'u1', orgId: 'o1' });
    expect(updated.status).toBe('running');
  });

  it('lists jobs with scope filtering', async () => {
    await store.create({ type: 'search', params: { query: 'a' }, userId: 'u1', orgId: 'o1' });
    await store.create({ type: 'search', params: { query: 'b' }, userId: 'u2', orgId: 'o1' });
    const jobs = await store.list({ userId: 'u1', orgId: 'o1' }, { limit: 50 });
    expect(jobs.length).toBe(1);
  });

  it('gets daily usage', async () => {
    await store.create({ type: 'search', params: { query: 'a' }, userId: 'u1', orgId: 'o1' });
    await store.create({ type: 'search', params: { query: 'b' }, userId: 'u1', orgId: 'o1' });
    const usage = await store.getUsage('u1');
    expect(usage.web_search_requests).toBe(2);
  });

  it('retries a failed job', async () => {
    const job = await store.create({ type: 'search', params: { query: 'fail' }, userId: 'u1', orgId: 'o1' });
    await store.update(job.id, { status: 'failed', error: 'timeout' });
    const retried = await store.retry(job.id, { userId: 'u1', orgId: 'o1' });
    expect(retried).toBeTruthy();
    expect(retried.id).not.toBe(job.id);
    expect(retried.status).toBe('queued');
    expect(retried.retried_from).toBe(job.id);
  });

  it('refuses retry on non-failed job', async () => {
    const job = await store.create({ type: 'search', params: { query: 'ok' }, userId: 'u1', orgId: 'o1' });
    await expect(store.retry(job.id, { userId: 'u1', orgId: 'o1' })).rejects.toThrow(/Only failed jobs/);
  });

  it('gets monthly usage', async () => {
    await store.create({ type: 'search', params: { query: 'a' }, userId: 'u1', orgId: 'o1' });
    const monthly = await store.getMonthlyUsage('u1');
    expect(monthly.web_search_requests.used).toBe(1);
    expect(monthly.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it('gets metrics', async () => {
    await store.create({ type: 'search', params: { query: 'a' }, userId: 'u1', orgId: 'o1' });
    const job2 = await store.create({ type: 'crawl', params: { urls: ['https://x.com'] }, userId: 'u1', orgId: 'o1' });
    await store.update(job2.id, { status: 'succeeded', duration_ms: 1500, runtime_used: 'lightpanda', results: [{ url: 'https://x.com' }] });
    const metrics = await store.getMetrics();
    expect(metrics.total_jobs).toBe(2);
    expect(metrics.succeeded).toBe(1);
    expect(metrics.runtime_distribution.lightpanda).toBe(1);
  });

  it('checks limits', async () => {
    const limits = await store.checkLimits('u1');
    expect(limits.daily).toBeTruthy();
    expect(limits.monthly).toBeTruthy();
    expect(limits.daily.search.hard).toBeGreaterThan(0);
  });

  it('exports usage', async () => {
    await store.create({ type: 'search', params: { query: 'a' }, userId: 'u1', orgId: 'o1' });
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const data = await store.exportUsage({ userId: 'u1', orgId: 'o1' }, { from, to });
    expect(Array.isArray(data)).toBe(true);
  });
});

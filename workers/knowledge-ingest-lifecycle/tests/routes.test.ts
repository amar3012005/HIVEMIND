import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class WorkflowEntrypoint {
    env: unknown;
    constructor(ctx: unknown, env: unknown) { this.env = env; }
  },
}));
vi.mock('cloudflare:workflows', () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));

let handler: { fetch(request: Request, env: any): Promise<Response> };

beforeAll(async () => {
  handler = (await import('../src/index')).default;
});

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://worker.example${path}`, {
    ...init,
    headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    KNOWLEDGE_INGEST_WORKFLOW_SECRET: 'test-secret',
    ENVIRONMENT: 'enigma',
    FLAGS: { getBooleanDetails: vi.fn(async () => ({ value: true, variant: 'on', reason: 'targeted' })) },
    INGEST_QUEUE: { send: vi.fn(async () => {}) },
    INGEST_WORKFLOW: {
      get: vi.fn(async (id: string) => ({ id, status: async () => ({ status: 'waiting' }) })),
    },
    ...overrides,
  };
}

describe('knowledge ingestion Worker HTTP contract', () => {
  it('admits only an opaque job/version payload', async () => {
    const runtime = env();
    const response = await handler.fetch(request('/start', {
      method: 'POST',
      body: JSON.stringify({
        job_id: '11111111-1111-4111-8111-111111111111',
        processing_version: 2,
        admitted: true,
      }),
    }), runtime);
    expect(response.status).toBe(202);
    expect(runtime.INGEST_QUEUE.send).toHaveBeenCalledWith({
      job_id: '11111111-1111-4111-8111-111111111111', processing_version: 2, admitted: true,
    }, { contentType: 'json' });
  });

  it('rejects tenant identifiers and never queues them', async () => {
    const runtime = env();
    const response = await handler.fetch(request('/start', {
      method: 'POST',
      body: JSON.stringify({
        job_id: '11111111-1111-4111-8111-111111111111', processing_version: 2, admitted: true,
        org_id: '22222222-2222-4222-8222-222222222222',
      }),
    }), runtime);
    expect(response.status).toBe(400);
    expect(runtime.INGEST_QUEUE.send).not.toHaveBeenCalled();
  });

  it('rejects content-bearing admission payloads before Queue or Workflow state', async () => {
    for (const forbidden of ['filename', 'text', 'chunks', 'metadata', 'prompt', 'embedding']) {
      const runtime = env();
      const response = await handler.fetch(request('/start', {
        method: 'POST',
        body: JSON.stringify({
          job_id: '11111111-1111-4111-8111-111111111111',
          processing_version: 2,
          admitted: true,
          [forbidden]: 'customer-content',
        }),
      }), runtime);
      expect(response.status).toBe(400);
      expect(runtime.INGEST_QUEUE.send).not.toHaveBeenCalled();
    }
  });

  it('returns one flat Workflow status', async () => {
    const response = await handler.fetch(request('/status?instance_id=kb-job-v1'), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ instance_id: 'kb-job-v1', status: 'waiting' });
  });

  it('returns a coarse status error without provider details', async () => {
    const runtime = env({ INGEST_WORKFLOW: { get: vi.fn(async () => { throw new Error('sensitive provider body'); }) } });
    const response = await handler.fetch(request('/status?instance_id=kb-job-v1'), runtime);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain('workflow_status_unavailable');
    expect(text).not.toContain('sensitive provider body');
  });

  it('does not expose the retired R2 object route', async () => {
    const response = await handler.fetch(request('/objects/source-key'), env());
    expect(response.status).toBe(404);
  });
});

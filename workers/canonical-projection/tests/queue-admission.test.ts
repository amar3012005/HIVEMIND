import { describe, expect, it, vi } from 'vitest';
import { admitQueuedProjection } from '../src/queue-admission';

const params = {
  memory_id: '74fb72fc-08da-41cc-8c56-598eae67bfee',
  org_id: '22222222-2222-4222-8222-222222222222',
  processing_version: 1,
  required_projection: 'shadow' as const,
};

describe('Queue admission', () => {
  it('observes an existing failed Workflow without restarting it', async () => {
    const status = vi.fn(async () => ({ status: 'errored' }));
    const workflow = {
      create: vi.fn(async () => { throw new Error('already exists'); }),
      get: vi.fn(async () => ({ status })),
    };
    await admitQueuedProjection(workflow, params);
    expect(workflow.create).toHaveBeenCalledTimes(1);
    expect(workflow.get).toHaveBeenCalledWith('claim-74fb72fc-08da-41cc-8c56-598eae67bfee-v1');
    expect(status).toHaveBeenCalledTimes(1);
    expect('restart' in workflow).toBe(false);
  });
});

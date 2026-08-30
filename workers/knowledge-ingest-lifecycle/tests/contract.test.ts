import { describe, expect, it } from 'vitest';
import { validParams, workflowInstanceId } from '../src/contract';

const params = {
  job_id: '11111111-1111-4111-8111-111111111111',
  org_id: '22222222-2222-4222-8222-222222222222',
  processing_version: 3,
};

describe('knowledge ingest workflow identity', () => {
  it('accepts only tenant-scoped durable identifiers', () => {
    expect(validParams(params)).toBe(true);
    expect(validParams({ ...params, org_id: 'not-an-org' })).toBe(false);
    expect(validParams({ ...params, processing_version: 0 })).toBe(false);
  });

  it('uses one deterministic workflow instance per job version', () => {
    expect(workflowInstanceId(params)).toBe('kb-11111111-1111-4111-8111-111111111111-v3');
  });
});

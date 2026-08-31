import { describe, expect, it } from 'vitest';
import { validParams, workflowInstanceId } from '../src/contract';

const params = {
  memory_id: '74fb72fc-08da-41cc-8c56-598eae67bfee',
  org_id: '22222222-2222-4222-8222-222222222222',
  processing_version: 1,
  required_projection: 'write' as const,
};

describe('canonical projection durable envelope', () => {
  it('contains identifiers and the latched projection mode only', () => {
    expect(validParams(params)).toBe(true);
    expect(validParams({ ...params, content: 'Uwe teaches deep learning' })).toBe(false);
    expect(validParams({ ...params, user_id: '33333333-3333-4333-8333-333333333333' })).toBe(false);
    expect(validParams({ ...params, required_projection: 'off' })).toBe(false);
    expect(validParams({ ...params, processing_version: 0 })).toBe(false);
  });

  it('uses one deterministic instance per memory processing version', () => {
    expect(workflowInstanceId(params)).toBe('claim-74fb72fc-08da-41cc-8c56-598eae67bfee-v1');
  });
});

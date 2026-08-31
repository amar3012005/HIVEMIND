import { describe, expect, it } from 'vitest';
import {
  materializationPollDecision, validAdmittedParams, validParams,
  workflowFailureDisposition, workflowInstanceId,
} from '../src/contract';

const params = {
  job_id: '11111111-1111-4111-8111-111111111111',
  org_id: '22222222-2222-4222-8222-222222222222',
  user_id: '33333333-3333-4333-8333-333333333333',
  processing_version: 3,
};

describe('knowledge ingest workflow identity', () => {
  it('accepts only tenant-scoped durable identifiers', () => {
    expect(validParams(params)).toBe(true);
    expect(validParams({ ...params, org_id: 'not-an-org' })).toBe(false);
    expect(validParams({ ...params, user_id: 'not-a-user' })).toBe(false);
    expect(validParams({ job_id: params.job_id, org_id: params.org_id, processing_version: 3 })).toBe(false);
    expect(validParams({ ...params, processing_version: 0 })).toBe(false);
  });

  it('uses one deterministic workflow instance per job version', () => {
    expect(workflowInstanceId(params)).toBe('kb-11111111-1111-4111-8111-111111111111-v3');
  });

  it('requires one latched Flagship admission before queue or Workflow execution', () => {
    expect(validAdmittedParams(params)).toBe(false);
    expect(validAdmittedParams({ ...params, admitted: true })).toBe(true);
  });

  it('never redispatches a terminal materialization failure', () => {
    expect(materializationPollDecision({ status: 'failed', retryable: false })).toBe('fail');
    expect(materializationPollDecision({ status: 'failed', retryable: true })).toBe('redispatch');
    expect(materializationPollDecision({ status: 'pending' })).toBe('redispatch');
    expect(materializationPollDecision({ status: 'processing' })).toBe('wait');
    expect(materializationPollDecision({ status: 'succeeded' })).toBe('complete');
  });

  it('preserves credits and schedules recovery for runtime interruptions only', () => {
    expect(workflowFailureDisposition(false)).toEqual({
      terminal: false,
      retryable: true,
      errorCode: 'WORKFLOW_RETRYABLE_INTERRUPTION',
      enqueueRecovery: true,
    });
    expect(workflowFailureDisposition(true)).toEqual({
      terminal: true,
      retryable: false,
      errorCode: 'WORKFLOW_NON_RETRYABLE',
      enqueueRecovery: false,
    });
  });
});

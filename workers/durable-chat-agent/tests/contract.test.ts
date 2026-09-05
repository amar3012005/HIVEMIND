import { describe, expect, it } from 'vitest';
import { isTerminalMetadata, validateMetadata, validateWorkflowParams, type SessionMetadata } from '../src/contract';

const valid: SessionMetadata = {
  event_id: '74fb72fc-08da-41cc-8c56-598eae67bfee:3',
  run_id: 'f8c2fc70-b521-43e1-8e0d-156b74360c80',
  turn_id: '74fb72fc-08da-41cc-8c56-598eae67bfee',
  mode: 'session', sequence: 3, event_type: 'coverage_assessed',
  phase: 'recall_verified', status: 'running', trace_id: 'abc123',
  occurred_at: '2026-08-31T12:00:00.000Z',
  state: 'tool_executed',
};

describe('metadata-only Cloudflare session contract', () => {
  it('accepts bounded execution metadata', () => expect(validateMetadata(valid)).toEqual(valid));
  for (const forbidden of ['message', 'content', 'prompt', 'answer', 'response', 'memory', 'evidence', 'citations', 'tool_output']) {
    it(`rejects customer field ${forbidden}`, () => expect(() => validateMetadata({ ...valid, [forbidden]: 'private' })).toThrow(/forbidden/));
  }
  it('rejects arbitrary extra fields', () => expect(() => validateMetadata({ ...valid, anything: 'x' })).toThrow(/forbidden/));
  it('rejects invalid turn identifiers', () => expect(() => validateMetadata({ ...valid, turn_id: '../tenant' })).toThrow('invalid_turn_id'));
});

describe('metadata-only Workflow contract', () => {
  it('accepts only opaque turn identity and latched mode', () => {
    expect(validateWorkflowParams({ turn_id: valid.turn_id, mode: 'full' }))
      .toEqual({ turn_id: valid.turn_id, mode: 'full' });
  });
  it('rejects customer content in workflow parameters', () => {
    expect(() => validateWorkflowParams({ turn_id: valid.turn_id, mode: 'full', prompt: 'private' }))
      .toThrow('workflow_params_forbidden');
  });
  it('recognizes only terminal lifecycle receipts', () => {
    expect(isTerminalMetadata({ ...valid, status: 'running' })).toBe(false);
    expect(isTerminalMetadata({ ...valid, status: 'completed' })).toBe(true);
    expect(isTerminalMetadata({ ...valid, status: 'failed' })).toBe(true);
  });
});

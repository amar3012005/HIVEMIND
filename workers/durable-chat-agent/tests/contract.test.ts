import { describe, expect, it } from 'vitest';
import { validateMetadata } from '../src/contract';

const valid = {
  turn_id: '74fb72fc-08da-41cc-8c56-598eae67bfee',
  mode: 'session', sequence: 3, event_type: 'coverage_assessed',
  phase: 'recall_verified', status: 'running', trace_id: 'abc123',
  occurred_at: '2026-08-31T12:00:00.000Z',
};

describe('metadata-only Cloudflare session contract', () => {
  it('accepts bounded execution metadata', () => expect(validateMetadata(valid)).toEqual(valid));
  for (const forbidden of ['message', 'content', 'prompt', 'answer', 'response', 'memory', 'evidence', 'citations', 'tool_output']) {
    it(`rejects customer field ${forbidden}`, () => expect(() => validateMetadata({ ...valid, [forbidden]: 'private' })).toThrow(/forbidden/));
  }
  it('rejects arbitrary extra fields', () => expect(() => validateMetadata({ ...valid, anything: 'x' })).toThrow(/forbidden/));
  it('rejects invalid turn identifiers', () => expect(() => validateMetadata({ ...valid, turn_id: '../tenant' })).toThrow('invalid_turn_id'));
});

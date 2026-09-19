import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { publicWorkRunError, normalizeAgentScopeEvent, WORK_RUN_EVENT } from '../../src/employees/work-runs.js';

describe('publicWorkRunError', () => {
  it('never echoes a gateway payload', () => {
    const e = publicWorkRunError({ type: 'invalid_request', message: 'The request to the model was rejected as invalid.' });
    assert.equal(e.code, 'MODEL_INVALID_REQUEST');
    assert.equal(e.retryable, true);
    assert.doesNotMatch(e.message, /gateway|cf-aig|CompressContext/i);
  });

  it('REPLY_END error becomes workrun.failed with public error', () => {
    const ev = normalizeAgentScopeEvent({
      type: 'REPLY_END',
      finished_reason: 'error',
      error: { type: 'invalid_request', message: 'The request to the model was rejected as invalid.' },
    });
    assert.equal(ev.t, WORK_RUN_EVENT.FAILED);
    assert.equal(ev.error.code, 'MODEL_INVALID_REQUEST');
  });
});

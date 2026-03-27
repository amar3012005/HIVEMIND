// tests/executor/decision/store-decision.test.js
import { describe, it, expect } from 'vitest';
import { computeDecisionStatus } from '../../../core/src/executor/decision/store-decision.js';

describe('computeDecisionStatus', () => {
  it('should auto-validate high confidence + multi-platform', () => {
    const { status } = computeDecisionStatus(0.9, 0.8, 2);
    expect(status).toBe('validated');
  });

  it('should stay candidate with single source', () => {
    const { status, state_reason } = computeDecisionStatus(0.7, 0.5, 1);
    expect(status).toBe('candidate');
    expect(state_reason).toBe('single_source_only');
  });

  it('should stay candidate with low confidence', () => {
    const { status } = computeDecisionStatus(0.5, 0.3, 3);
    expect(status).toBe('candidate');
  });
});

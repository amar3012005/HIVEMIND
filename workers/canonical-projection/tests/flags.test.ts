import { describe, expect, it, vi } from 'vitest';
import { evaluateProjectionMode, evaluateRecallReliability } from '../src/flags';

const org = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';

function environment(value: string | Error, enabled = 'true') {
  return {
    ENVIRONMENT: 'local', CANONICAL_KNOWLEDGE_FLAG: 'canonical_knowledge_foundation_v1', CANONICAL_KNOWLEDGE_ENABLED: enabled,
    FLAGS: { getStringDetails: vi.fn(async () => { if (value instanceof Error) throw value; return { value, variant: 'test', reason: 'STATIC' }; }) },
  } as unknown as Parameters<typeof evaluateProjectionMode>[0];
}

describe('multivariate canonical knowledge gate', () => {
  it.each(['shadow', 'write', 'read', 'full'])('accepts the %s variation', async (mode) => {
    expect(await evaluateProjectionMode(environment(mode), org, user)).toBe(mode);
  });

  it('fails closed for kill switch, errors, unknown variations, and invalid identity', async () => {
    expect(await evaluateProjectionMode(environment('full', 'false'), org, user)).toBe('off');
    expect(await evaluateProjectionMode(environment(new Error('flag unavailable')), org, user)).toBe('off');
    expect(await evaluateProjectionMode(environment('unexpected'), org, user)).toBe('off');
    expect(await evaluateProjectionMode(environment('full'), org, 'invalid')).toBe('off');
  });
});

describe('recall reliability gate', () => {
  it('serves the boolean flag and fails closed', async () => {
    const enabled = {
      ENVIRONMENT: 'production', RECALL_PARALLEL_RELIABILITY_ENABLED: 'true',
      RECALL_RELIABILITY_FLAG: 'recall_parallel_reliability_v1',
      FLAGS: { getBooleanDetails: vi.fn(async () => ({ value: true, variant: 'on', reason: 'TARGETING_MATCH' })) },
    } as unknown as Parameters<typeof evaluateRecallReliability>[0];
    expect(await evaluateRecallReliability(enabled, org, user)).toBe(true);
    expect(await evaluateRecallReliability({ ...enabled, RECALL_PARALLEL_RELIABILITY_ENABLED: 'false' }, org, user)).toBe(false);
    expect(await evaluateRecallReliability(enabled, org, 'invalid')).toBe(false);
  });
});

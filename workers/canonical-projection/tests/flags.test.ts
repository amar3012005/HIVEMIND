import { describe, expect, it, vi } from 'vitest';
import { evaluateHmUnderstandMode, evaluateProjectionMode, evaluateRecallReliability } from '../src/flags';

const org = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';

describe('dedicated hm-understand gate', () => {
  it('uses only the exact tenant-targeted hm_understand_v1 decision', async () => {
    const getStringDetails = vi.fn(async () => ({ value: 'shadow', variant: 'internal', reason: 'TARGETING_MATCH' }));
    const env = { ENVIRONMENT: 'local', FLAGS: { getStringDetails } } as unknown as Parameters<typeof evaluateHmUnderstandMode>[0];
    expect(await evaluateHmUnderstandMode(env, org, user)).toBe('shadow');
    expect(getStringDetails).toHaveBeenCalledWith('hm_understand_v1', 'off', {
      targetingKey: `${org}:${user}`, org_id: org, user_id: user, environment: 'local',
    });
  });

  it('accepts assisted as a bounded variation of the same feature flag', async () => {
    const env = { ENVIRONMENT: 'local', FLAGS: { getStringDetails: vi.fn(async () => ({ value: 'assisted' })) } } as unknown as Parameters<typeof evaluateHmUnderstandMode>[0];
    expect(await evaluateHmUnderstandMode(env, org, user)).toBe('assisted');
  });

  it('is default-off and fails closed for other variations, invalid identities, and Flagship errors', async () => {
    let fail = false;
    const getStringDetails = vi.fn(async () => {
      if (fail) throw new Error('unavailable');
      return { value: 'future_mode', variant: 'future', reason: 'STATIC' };
    });
    const env = { ENVIRONMENT: 'production', FLAGS: { getStringDetails } } as unknown as Parameters<typeof evaluateHmUnderstandMode>[0];
    expect(await evaluateHmUnderstandMode(env, org, user)).toBe('off');
    expect(await evaluateHmUnderstandMode(env, 'bad-org', user)).toBe('off');
    fail = true;
    expect(await evaluateHmUnderstandMode(env, org, user)).toBe('off');
  });
});

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

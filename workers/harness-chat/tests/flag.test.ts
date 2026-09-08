import { describe, expect, it, vi } from 'vitest';
import { evaluateHarnessChatMode, HIVE_HARNESS_CHAT_FLAG_KEY, type Env } from '../src/index';

const orgId = '67503d34-97e9-49a8-8c52-8ee30cc7603e';
const userId = '54f5568b-4d6a-4ae1-9a33-48cb2909d59b';

describe('harness chat Flagship gate', () => {
  it('accepts only the three contract variations and uses tenant targeting', async () => {
    const getStringDetails = vi.fn(async () => ({ value: 'harness', evaluationId: 'eval-1' }));
    const env = { ENVIRONMENT: 'production', FLAGS: { getStringDetails } } as unknown as Env;
    expect(await evaluateHarnessChatMode(env, orgId, userId)).toEqual({
      key: HIVE_HARNESS_CHAT_FLAG_KEY,
      source: 'cloudflare-flagship',
      variation: 'harness',
      evaluation_id: 'eval-1',
    });
    expect(getStringDetails).toHaveBeenCalledWith(HIVE_HARNESS_CHAT_FLAG_KEY, 'legacy', {
      targetingKey: `${orgId}:${userId}`, org_id: orgId, user_id: userId, environment: 'production',
    });
  });

  it('fails closed on invalid variations, invalid scope, and provider errors', async () => {
    const env = { ENVIRONMENT: 'production', FLAGS: {
      getStringDetails: vi.fn(async () => ({ value: 'enabled' })),
    } } as unknown as Env;
    expect((await evaluateHarnessChatMode(env, orgId, userId)).variation).toBe('legacy');
    expect((await evaluateHarnessChatMode(env, 'invalid', userId)).variation).toBe('legacy');
    env.FLAGS.getStringDetails = vi.fn(async () => { throw new Error('unavailable'); });
    expect((await evaluateHarnessChatMode(env, orgId, userId)).variation).toBe('legacy');
  });
});

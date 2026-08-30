import { describe, expect, it, vi } from 'vitest';
import { evaluateProjectionMode } from '../src/flags';

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

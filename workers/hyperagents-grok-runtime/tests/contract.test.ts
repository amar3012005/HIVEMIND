import { describe, expect, it } from 'vitest';
import { modeRank, normalizeMode, validParams, workflowId } from '../src/contract';

const params = {
  turn_id: '11111111-1111-4111-8111-111111111111',
  room_id: '22222222-2222-4222-8222-222222222222',
  org_id: '33333333-3333-4333-8333-333333333333',
  user_id: '44444444-4444-4444-8444-444444444444',
  mode: 'durable_assignments' as const,
  processing_version: 1,
};

describe('Grok HyperAgents contract', () => {
  it('fails closed on unknown modes', () => expect(normalizeMode('future')).toBe('off'));
  it('orders cumulative stages', () => expect(modeRank('real_tools')).toBeGreaterThan(modeRank('persistent_agents')));
  it('accepts identifier-only workflow messages', () => expect(validParams(params)).toBe(true));
  it('uses deterministic workflow identity', () => expect(workflowId(params.turn_id, 1)).toBe(`room-${params.turn_id}-v1`));
});

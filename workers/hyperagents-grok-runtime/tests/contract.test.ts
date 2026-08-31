import { describe, expect, it } from 'vitest';
import { assignmentWorkflowId, modeRank, normalizeMode, publicHttpsUrl, validAssignmentParams, validParams, workflowId } from '../src/contract';

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
  it('uses a deterministic workflow for every real assignment', () => {
    const assignment = { ...params, work_order_id: '55555555-5555-4555-8555-555555555555', agent_instance_id: `ha-${'a'.repeat(32)}-v1` };
    expect(validAssignmentParams(assignment)).toBe(true);
    expect(assignmentWorkflowId(assignment.work_order_id, 1)).toBe(`agent-${assignment.work_order_id}-v1`);
  });
  it('admits public HTTPS pages and rejects local, credentialed, and nonstandard endpoints', () => {
    expect(publicHttpsUrl('https://example.com/pricing')?.hostname).toBe('example.com');
    for (const url of [
      'http://example.com', 'https://localhost/x', 'https://127.0.0.1/x',
      'https://10.0.0.3/x', 'https://172.20.1.2/x', 'https://192.168.1.1/x',
      'https://169.254.169.254/latest/meta-data', 'https://user:pass@example.com/x',
      'https://example.com:8443/x', 'https://[::1]/x',
    ]) expect(publicHttpsUrl(url)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { isTerminalMetadata, validateMetadata, validateWorkflowParams, type SessionMetadata } from '../src/contract';
import { evaluateNativeMetaMode } from '../src/native-meta-flag';

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

describe('native meta Flagship admission', () => {
  const url = new URL('https://worker/native-meta-mode?org_id=org-1&user_id=user-1');
  it('fails closed when the local master switch is off', async () => {
    let evaluated = false;
    const env = {
      NATIVE_META_TOOLS_ENABLED: 'false', ENVIRONMENT: 'production',
      FLAGS: { getBooleanDetails: async () => { evaluated = true; return { value: true }; } },
    } as unknown as Parameters<typeof evaluateNativeMetaMode>[0];
    expect(await evaluateNativeMetaMode(env, url)).toBe('off');
    expect(evaluated).toBe(false);
  });
  it('uses a stable tenant-user targeting key and accepts only true', async () => {
    let context: Record<string, unknown> | undefined;
    const env = {
      NATIVE_META_TOOLS_ENABLED: 'true', NATIVE_META_FLAG: 'hivemind-native-meta-tools-v1', ENVIRONMENT: 'production',
      FLAGS: { getBooleanDetails: async (_key: string, _fallback: boolean, ctx?: Record<string, string | number | boolean>) => { context = ctx; return { value: true }; } },
    } as unknown as Parameters<typeof evaluateNativeMetaMode>[0];
    expect(await evaluateNativeMetaMode(env, url)).toBe('native-meta-v1');
    expect(context?.targetingKey).toBe('org-1:user-1');
  });
  it('fails closed on Flagship errors', async () => {
    const env = {
      NATIVE_META_TOOLS_ENABLED: 'true', ENVIRONMENT: 'production',
      FLAGS: { getBooleanDetails: async () => { throw new Error('offline'); } },
    } as unknown as Parameters<typeof evaluateNativeMetaMode>[0];
    expect(await evaluateNativeMetaMode(env, url)).toBe('off');
  });
});

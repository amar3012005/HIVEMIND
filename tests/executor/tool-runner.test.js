/**
 * Trail Executor — ToolRunner Tests
 * HIVE-MIND Cognitive Runtime
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../core/src/executor/tool-registry.js';
import { ToolRunner } from '../../core/src/executor/tool-runner.js';

/** Reusable tool definition fixture */
function makeToolDef(overrides = {}) {
  return {
    name: 'call_api',
    description: 'Make an HTTP API call',
    params: {
      url: { type: 'string', required: true, description: 'Target URL' },
      method: { type: 'string', required: false, description: 'HTTP method' },
    },
    maxTokens: 5000,
    timeoutMs: 30000,
    ...overrides,
  };
}

/** Reusable BoundAction fixture */
function makeAction(overrides = {}) {
  return {
    toolName: 'call_api',
    params: { url: 'https://example.com' },
    trailId: 'trail-1',
    stepIndex: 0,
    ...overrides,
  };
}

describe('ToolRunner', () => {
  /** @type {ToolRegistry} */
  let registry;
  /** @type {ToolRunner} */
  let runner;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeToolDef());
    runner = new ToolRunner(registry);
  });

  it('should execute registered tool and return result', async () => {
    runner.register('call_api', async (params) => {
      return { status: 200, body: `response from ${params.url}` };
    });

    const result = await runner.run(makeAction());
    expect(result.success).toBe(true);
    expect(result.output.status).toBe(200);
    expect(result.output.body).toContain('example.com');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should throw for unregistered tool', async () => {
    // No executor registered for call_api
    const result = await runner.run(makeAction());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No executor for tool');
  });

  it('should throw when validation fails (missing param)', async () => {
    runner.register('call_api', async () => ({ ok: true }));

    const action = makeAction({ params: {} }); // missing required 'url'
    await expect(runner.run(action)).rejects.toThrow('Validation failed');
  });

  it('should throw when budget exceeded', async () => {
    runner.register('call_api', async () => ({ ok: true }));

    const budget = { maxTokens: 1000 }; // tool requires 5000
    await expect(runner.run(makeAction(), budget)).rejects.toThrow('Validation failed');
  });

  it('should track latency in result', async () => {
    runner.register('call_api', async () => {
      await new Promise(r => setTimeout(r, 50));
      return { ok: true };
    });

    const result = await runner.run(makeAction());
    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(40);
  });

  it('should timeout long-running tools', async () => {
    // Register tool def with very short timeout
    registry.register({
      name: 'slow_tool',
      description: 'A very slow tool',
      params: { url: { type: 'string', required: true } },
      timeoutMs: 50,
    });

    runner.register('slow_tool', async (_params, signal) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    });

    const action = makeAction({ toolName: 'slow_tool' });
    const result = await runner.run(action);
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('should handle executor errors gracefully', async () => {
    runner.register('call_api', async () => {
      throw new Error('Connection refused');
    });

    const result = await runner.run(makeAction());
    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection refused');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

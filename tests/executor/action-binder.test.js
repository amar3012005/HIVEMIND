/**
 * Trail Executor — ActionBinder Tests
 * HIVE-MIND Cognitive Runtime
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../core/src/executor/tool-registry.js';
import { ActionBinder } from '../../core/src/executor/action-binder.js';

/** Reusable tool definition fixture */
function makeToolDef(overrides = {}) {
  return {
    name: 'call_api',
    description: 'Make an HTTP API call',
    params: {
      url: { type: 'string', required: true, description: 'Target URL' },
      apiKey: { type: 'string', required: false, description: 'API key' },
      query: { type: 'string', required: false, description: 'Query string' },
    },
    timeoutMs: 15000,
    ...overrides,
  };
}

describe('ActionBinder', () => {
  /** @type {ToolRegistry} */
  let registry;
  /** @type {ActionBinder} */
  let binder;

  const workingMemory = {
    context: {
      targetUrl: 'https://api.example.com/data',
      userId: 'user-42',
    },
    observations: [
      { eventId: 'e1', kind: 'tool_output', content: 'old tool result', timestamp: 1000 },
      { eventId: 'e2', kind: 'recall_hit', content: 'recalled info', timestamp: 2000 },
      { eventId: 'e3', kind: 'tool_output', content: 'latest tool result', timestamp: 3000 },
    ],
  };

  const canonicalState = {
    facts: {
      github_api_key: 'ghp_secret123',
      org_name: 'hivemind-org',
    },
  };

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeToolDef());
    binder = new ActionBinder(registry);
  });

  it('should resolve $ctx. params from working memory context', async () => {
    const actionRef = {
      tool: 'call_api',
      paramsTemplate: { url: '$ctx.targetUrl' },
    };

    const bound = await binder.bind(actionRef, workingMemory, canonicalState);
    expect(bound.params.url).toBe('https://api.example.com/data');
    expect(bound.toolName).toBe('call_api');
  });

  it('should resolve $kg. params from canonical state', async () => {
    const actionRef = {
      tool: 'call_api',
      paramsTemplate: { url: 'https://api.github.com', apiKey: '$kg.github_api_key' },
    };

    const bound = await binder.bind(actionRef, workingMemory, canonicalState);
    expect(bound.params.apiKey).toBe('ghp_secret123');
  });

  it('should resolve $obs. params from latest observation by kind', async () => {
    const actionRef = {
      tool: 'call_api',
      paramsTemplate: { url: 'https://example.com', query: '$obs.tool_output' },
    };

    const bound = await binder.bind(actionRef, workingMemory, canonicalState);
    // Should pick the latest tool_output (timestamp 3000)
    expect(bound.params.query).toBe('latest tool result');
  });

  it('should pass literal values through unchanged', async () => {
    const actionRef = {
      tool: 'call_api',
      paramsTemplate: { url: 'https://literal.example.com', query: 'fixed_value' },
    };

    const bound = await binder.bind(actionRef, workingMemory, canonicalState);
    expect(bound.params.url).toBe('https://literal.example.com');
    expect(bound.params.query).toBe('fixed_value');
  });

  it('should throw when required $ctx. param is missing', async () => {
    const actionRef = {
      tool: 'call_api',
      paramsTemplate: { url: '$ctx.nonExistentKey' },
    };

    await expect(binder.bind(actionRef, workingMemory, canonicalState))
      .rejects.toThrow('context key "nonExistentKey" not found');
  });

  it('should handle mixed param types (some resolved, some literal)', async () => {
    const actionRef = {
      tool: 'call_api',
      paramsTemplate: {
        url: '$ctx.targetUrl',
        apiKey: '$kg.github_api_key',
        query: 'fixed_value',
      },
    };

    const bound = await binder.bind(actionRef, workingMemory, canonicalState);
    expect(bound.params.url).toBe('https://api.example.com/data');
    expect(bound.params.apiKey).toBe('ghp_secret123');
    expect(bound.params.query).toBe('fixed_value');
    expect(bound.timeoutMs).toBe(15000);
  });
});

/**
 * Trail Executor — ToolRegistry Tests
 * HIVE-MIND Cognitive Runtime
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../core/src/executor/tool-registry.js';

/** Reusable tool definition fixture */
function makeToolDef(overrides = {}) {
  return {
    name: 'call_api',
    description: 'Make an HTTP API call',
    params: {
      url: { type: 'string', required: true, description: 'Target URL' },
      method: { type: 'string', required: false, description: 'HTTP method', default: 'GET' },
      body: { type: 'object', required: false, description: 'Request body' },
    },
    maxTokens: 10000,
    timeoutMs: 30000,
    requiresPermission: ['network'],
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

describe('ToolRegistry', () => {
  /** @type {ToolRegistry} */
  let registry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('should register a tool and retrieve it', () => {
    const def = makeToolDef();
    registry.register(def);

    const retrieved = registry.getDefinition('call_api');
    expect(retrieved).toBeDefined();
    expect(retrieved.name).toBe('call_api');
    expect(retrieved.params.url.type).toBe('string');
  });

  it('should reject action with unknown tool name', () => {
    registry.register(makeToolDef());

    const result = registry.validate(makeAction({ toolName: 'nonexistent' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  it('should reject action with missing required param', () => {
    registry.register(makeToolDef());

    const result = registry.validate(makeAction({ params: {} }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Missing required param');
    expect(result.error).toContain('url');
  });

  it('should reject action with wrong param type', () => {
    registry.register(makeToolDef());

    const result = registry.validate(makeAction({ params: { url: 12345 } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('expected type "string"');
    expect(result.error).toContain('got "number"');
  });

  it('should accept valid action with all required params', () => {
    registry.register(makeToolDef());

    const result = registry.validate(makeAction());
    expect(result.ok).toBe(true);
  });

  it('should accept valid action with optional params omitted', () => {
    registry.register(makeToolDef());

    // Only providing required 'url', omitting optional 'method' and 'body'
    const result = registry.validate(makeAction({ params: { url: 'https://api.example.com' } }));
    expect(result.ok).toBe(true);
  });

  it('should reject when budget insufficient (tokens)', () => {
    registry.register(makeToolDef({ maxTokens: 10000 }));

    const result = registry.validate(makeAction(), { maxTokens: 5000 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('tokens');
    expect(result.error).toContain('budget');
  });

  it('should reject when budget insufficient (cost)', () => {
    registry.register(makeToolDef({ maxCostUsd: 0.50 }));

    const result = registry.validate(makeAction(), { maxCostUsd: 0.10 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('budget');
  });

  it('should accept when budget is sufficient', () => {
    registry.register(makeToolDef({ maxTokens: 5000, maxCostUsd: 0.10 }));

    const result = registry.validate(makeAction(), { maxTokens: 10000, maxCostUsd: 1.00 });
    expect(result.ok).toBe(true);
  });

  it('should list all registered tools', () => {
    registry.register(makeToolDef({ name: 'tool_a', description: 'Tool A' }));
    registry.register(makeToolDef({ name: 'tool_b', description: 'Tool B' }));
    registry.register(makeToolDef({ name: 'tool_c', description: 'Tool C' }));

    const tools = registry.listTools();
    expect(tools).toHaveLength(3);
    const names = tools.map(t => t.name);
    expect(names).toContain('tool_a');
    expect(names).toContain('tool_b');
    expect(names).toContain('tool_c');
  });

  it('should check tool existence with has()', () => {
    registry.register(makeToolDef());

    expect(registry.has('call_api')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });
});

/**
 * Tests: MCP tools visibility gating by scope
 */
import { describe, it, expect } from 'vitest';
import { handleToolsList } from '../../src/mcp/hosted-service.js';

function toolNames(result) {
  return result.tools.map(t => t.name);
}

describe('MCP tools visibility gating', () => {
  it('includes all web tools when scopes contain wildcard', () => {
    const result = handleToolsList('u1', 'o1', { scopes: ['*'] });
    const names = toolNames(result);
    expect(names).toContain('hivemind_web_search');
    expect(names).toContain('hivemind_web_crawl');
    expect(names).toContain('hivemind_web_job_status');
    expect(names).toContain('hivemind_web_usage');
  });

  it('includes web_search tool only when web_search scope present', () => {
    const result = handleToolsList('u1', 'o1', { scopes: ['memory:read', 'web_search'] });
    const names = toolNames(result);
    expect(names).toContain('hivemind_web_search');
    expect(names).not.toContain('hivemind_web_crawl');
    expect(names).toContain('hivemind_web_job_status');
    expect(names).toContain('hivemind_web_usage');
  });

  it('includes web_crawl tool only when web_crawl scope present', () => {
    const result = handleToolsList('u1', 'o1', { scopes: ['memory:read', 'web_crawl'] });
    const names = toolNames(result);
    expect(names).not.toContain('hivemind_web_search');
    expect(names).toContain('hivemind_web_crawl');
    expect(names).toContain('hivemind_web_job_status');
    expect(names).toContain('hivemind_web_usage');
  });

  it('includes both web tools when both scopes present', () => {
    const result = handleToolsList('u1', 'o1', { scopes: ['web_search', 'web_crawl'] });
    const names = toolNames(result);
    expect(names).toContain('hivemind_web_search');
    expect(names).toContain('hivemind_web_crawl');
    expect(names).toContain('hivemind_web_job_status');
    expect(names).toContain('hivemind_web_usage');
  });

  it('excludes ALL web tools when no web scopes present', () => {
    const result = handleToolsList('u1', 'o1', { scopes: ['memory:read', 'memory:write', 'mcp'] });
    const names = toolNames(result);
    expect(names).not.toContain('hivemind_web_search');
    expect(names).not.toContain('hivemind_web_crawl');
    expect(names).not.toContain('hivemind_web_job_status');
    expect(names).not.toContain('hivemind_web_usage');
  });

  it('excludes web tools when scopes is empty', () => {
    const result = handleToolsList('u1', 'o1', { scopes: [] });
    const names = toolNames(result);
    expect(names).not.toContain('hivemind_web_search');
    expect(names).not.toContain('hivemind_web_crawl');
  });

  it('still includes core memory tools regardless of web scopes', () => {
    const result = handleToolsList('u1', 'o1', { scopes: [] });
    const names = toolNames(result);
    expect(names).toContain('hivemind_save_memory');
    expect(names).toContain('hivemind_recall');
    expect(names).toContain('hivemind_list_memories');
  });

  it('defaults to no web tools when no options passed', () => {
    const result = handleToolsList('u1', 'o1');
    const names = toolNames(result);
    expect(names).not.toContain('hivemind_web_search');
    expect(names).not.toContain('hivemind_web_crawl');
    // Core tools still present
    expect(names).toContain('hivemind_save_memory');
  });
});

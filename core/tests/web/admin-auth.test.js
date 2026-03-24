/**
 * Tests: Admin metrics authorization
 *
 * These test the entitlement logic — actual HTTP testing requires a running server.
 * We test the hasEntitlement function with admin scope patterns.
 */
import { describe, it, expect } from 'vitest';
import { hasEntitlement, ENTITLEMENT_SCOPES } from '../../src/auth/api-keys.js';

describe('web_admin entitlement', () => {
  it('web_admin is in ENTITLEMENT_SCOPES', () => {
    expect(ENTITLEMENT_SCOPES).toContain('web_admin');
  });

  it('grants access with explicit web_admin scope', () => {
    const principal = { scopes: ['memory:read', 'web_admin'] };
    expect(hasEntitlement(principal, 'web_admin')).toBe(true);
  });

  it('grants access with wildcard scope', () => {
    const principal = { scopes: ['*'] };
    expect(hasEntitlement(principal, 'web_admin')).toBe(true);
  });

  it('denies access without web_admin scope', () => {
    const principal = { scopes: ['memory:read', 'memory:write', 'web_search', 'web_crawl'] };
    expect(hasEntitlement(principal, 'web_admin')).toBe(false);
  });

  it('denies access with empty scopes', () => {
    const principal = { scopes: [] };
    expect(hasEntitlement(principal, 'web_admin')).toBe(false);
  });

  it('denies access with null principal', () => {
    expect(hasEntitlement(null, 'web_admin')).toBe(false);
  });

  it('denies access with missing scopes array', () => {
    const principal = { userId: 'u1' };
    expect(hasEntitlement(principal, 'web_admin')).toBe(false);
  });
});

describe('defense in depth: web tool entitlements', () => {
  it('web_search scope check works correctly', () => {
    expect(hasEntitlement({ scopes: ['web_search'] }, 'web_search')).toBe(true);
    expect(hasEntitlement({ scopes: ['web_crawl'] }, 'web_search')).toBe(false);
    expect(hasEntitlement({ scopes: ['*'] }, 'web_search')).toBe(true);
  });

  it('web_crawl scope check works correctly', () => {
    expect(hasEntitlement({ scopes: ['web_crawl'] }, 'web_crawl')).toBe(true);
    expect(hasEntitlement({ scopes: ['web_search'] }, 'web_crawl')).toBe(false);
    expect(hasEntitlement({ scopes: ['*'] }, 'web_crawl')).toBe(true);
  });
});

describe('regression: admin key with wildcard gets full access', () => {
  it('wildcard scope grants all entitlements', () => {
    const admin = { scopes: ['*'] };
    for (const scope of ENTITLEMENT_SCOPES) {
      expect(hasEntitlement(admin, scope)).toBe(true);
    }
  });

  it('master key pattern (test/master) gets full access', () => {
    const master = { scopes: ['*'], master: true };
    expect(hasEntitlement(master, 'web_admin')).toBe(true);
    expect(hasEntitlement(master, 'web_search')).toBe(true);
    expect(hasEntitlement(master, 'web_crawl')).toBe(true);
    expect(hasEntitlement(master, 'memory:read')).toBe(true);
    expect(hasEntitlement(master, 'memory:write')).toBe(true);
    expect(hasEntitlement(master, 'mcp')).toBe(true);
  });
});
